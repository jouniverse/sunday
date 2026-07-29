//! A `Read + Seek` adapter over HTTP range requests.
//!
//! This is what lets a remote Cloud-Optimized GeoTIFF go through exactly the
//! same pure-Rust decode path as a local file: the TIFF decoder only needs
//! `Read + Seek`, so we satisfy that by fetching aligned blocks on demand and
//! keeping them in a small LRU cache. A polygon query over a 4 GB remote raster
//! therefore transfers kilobytes, not gigabytes.

use std::io::{self, Read, Seek, SeekFrom};
use std::num::NonZeroUsize;

use lru::LruCache;

/// Block size for range requests. 64 KiB is a good compromise: large enough to
/// amortise request overhead, small enough that reading a single COG tile does
/// not pull in unrelated data.
pub const BLOCK_SIZE: u64 = 64 * 1024;

/// Number of blocks kept in memory (~8 MiB at 64 KiB blocks).
const CACHE_BLOCKS: usize = 128;

pub struct HttpRangeReader {
    client: reqwest::blocking::Client,
    url: String,
    len: u64,
    pos: u64,
    cache: LruCache<u64, Vec<u8>>,
    /// Number of range requests issued; surfaced in diagnostics so we can prove
    /// that queries stay cheap.
    pub requests: u64,
}

impl HttpRangeReader {
    pub fn new(client: reqwest::blocking::Client, url: impl Into<String>) -> io::Result<Self> {
        let url = url.into();
        let len = probe_length(&client, &url)?;
        Ok(Self {
            client,
            url,
            len,
            pos: 0,
            cache: LruCache::new(NonZeroUsize::new(CACHE_BLOCKS).expect("nonzero")),
            requests: 0,
        })
    }

    pub fn len(&self) -> u64 {
        self.len
    }

    fn block(&mut self, index: u64) -> io::Result<&Vec<u8>> {
        if !self.cache.contains(&index) {
            let start = index * BLOCK_SIZE;
            if start >= self.len {
                return Err(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "block past end of resource",
                ));
            }
            let end = (start + BLOCK_SIZE - 1).min(self.len - 1);
            let bytes = self.fetch_range(start, end)?;
            self.requests += 1;
            self.cache.put(index, bytes);
        }
        Ok(self.cache.get(&index).expect("just inserted"))
    }

    fn fetch_range(&self, start: u64, end_inclusive: u64) -> io::Result<Vec<u8>> {
        let response = self
            .client
            .get(&self.url)
            .header("Range", format!("bytes={start}-{end_inclusive}"))
            .send()
            .map_err(to_io)?;
        if !response.status().is_success() {
            return Err(io::Error::other(format!(
                "range request failed with status {}",
                response.status()
            )));
        }
        let bytes = response.bytes().map_err(to_io)?;
        Ok(bytes.to_vec())
    }
}

fn probe_length(client: &reqwest::blocking::Client, url: &str) -> io::Result<u64> {
    // Prefer HEAD; some object stores answer HEAD without Content-Length, in
    // which case fall back to a one-byte ranged GET and read Content-Range.
    if let Ok(response) = client.head(url).send() {
        if response.status().is_success() {
            if let Some(len) = response
                .headers()
                .get(reqwest::header::CONTENT_LENGTH)
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.parse::<u64>().ok())
            {
                if len > 0 {
                    return Ok(len);
                }
            }
        }
    }

    let response = client
        .get(url)
        .header("Range", "bytes=0-0")
        .send()
        .map_err(to_io)?;
    let content_range = response
        .headers()
        .get(reqwest::header::CONTENT_RANGE)
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| io::Error::other("server does not support range requests"))?;
    parse_content_range_total(content_range)
        .ok_or_else(|| io::Error::other(format!("unparseable Content-Range: {content_range}")))
}

/// Parses the total size out of a `bytes 0-0/12345` style header value.
pub fn parse_content_range_total(value: &str) -> Option<u64> {
    let total = value.rsplit('/').next()?.trim();
    if total == "*" {
        return None;
    }
    total.parse().ok()
}

fn to_io(err: reqwest::Error) -> io::Error {
    io::Error::other(err.to_string())
}

impl Read for HttpRangeReader {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if self.pos >= self.len || buf.is_empty() {
            return Ok(0);
        }
        let index = self.pos / BLOCK_SIZE;
        let offset = (self.pos % BLOCK_SIZE) as usize;
        let block = self.block(index)?;
        if offset >= block.len() {
            return Ok(0);
        }
        let available = &block[offset..];
        let n = available.len().min(buf.len());
        buf[..n].copy_from_slice(&available[..n]);
        self.pos += n as u64;
        Ok(n)
    }
}

impl Seek for HttpRangeReader {
    fn seek(&mut self, pos: SeekFrom) -> io::Result<u64> {
        let next = match pos {
            SeekFrom::Start(n) => n as i64,
            SeekFrom::End(n) => self.len as i64 + n,
            SeekFrom::Current(n) => self.pos as i64 + n,
        };
        if next < 0 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "seek before start of resource",
            ));
        }
        self.pos = next as u64;
        Ok(self.pos)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_content_range_total() {
        assert_eq!(parse_content_range_total("bytes 0-0/12345"), Some(12345));
        assert_eq!(parse_content_range_total("bytes 0-0/*"), None);
        assert_eq!(parse_content_range_total("nonsense"), None);
    }
}

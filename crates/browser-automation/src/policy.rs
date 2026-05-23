use crate::{BrowserAutomationError, BrowserResult};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BrowserPolicy {
    allow_private_network: bool,
}

impl Default for BrowserPolicy {
    fn default() -> Self {
        Self {
            allow_private_network: false,
        }
    }
}

impl BrowserPolicy {
    pub fn with_private_network(mut self, allow_private_network: bool) -> Self {
        self.allow_private_network = allow_private_network;
        self
    }

    pub fn assert_navigation_allowed(&self, url: &str) -> BrowserResult<()> {
        let parsed = SimpleUrl::parse(url)?;
        match parsed.scheme.as_str() {
            "http" | "https" => {}
            "about" if parsed.raw == "about:blank" => return Ok(()),
            scheme => {
                return Err(BrowserAutomationError::NavigationBlocked(format!(
                    "unsupported protocol:{scheme}"
                )));
            }
        }

        if !self.allow_private_network && is_private_hostname(&parsed.hostname) {
            return Err(BrowserAutomationError::PrivateNetworkBlocked(
                parsed.hostname.to_string(),
            ));
        }
        Ok(())
    }
}

struct SimpleUrl<'a> {
    raw: &'a str,
    scheme: String,
    hostname: String,
}

impl<'a> SimpleUrl<'a> {
    fn parse(raw: &'a str) -> BrowserResult<Self> {
        let trimmed = raw.trim();
        let Some((scheme, rest)) = trimmed.split_once(':') else {
            return Err(BrowserAutomationError::NavigationBlocked(
                "invalid URL".to_string(),
            ));
        };
        let hostname = if rest.starts_with("//") {
            rest.trim_start_matches("//")
                .split(['/', ':', '?', '#'])
                .next()
                .unwrap_or_default()
                .to_ascii_lowercase()
        } else {
            String::new()
        };
        Ok(Self {
            raw: trimmed,
            scheme: scheme.to_ascii_lowercase(),
            hostname,
        })
    }
}

fn is_private_hostname(hostname: &str) -> bool {
    if hostname == "localhost" {
        return true;
    }
    match hostname.parse::<IpAddr>() {
        Ok(IpAddr::V4(ip)) => is_private_ipv4(ip),
        Ok(IpAddr::V6(ip)) => is_private_ipv6(ip),
        Err(_) => false,
    }
}

fn is_private_ipv4(ip: Ipv4Addr) -> bool {
    ip.is_loopback()
        || ip.is_private()
        || ip.is_link_local()
        || ip.octets()[0] == 0
        || ip.octets()[0] >= 224
}

fn is_private_ipv6(ip: Ipv6Addr) -> bool {
    ip.is_loopback() || ip.is_unique_local() || ip.is_unicast_link_local()
}

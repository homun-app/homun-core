use std::{
    env,
    net::{IpAddr, SocketAddr},
};

const DEFAULT_GATEWAY_PORT: u16 = 18_765;
const DEFAULT_GATEWAY_HOST: [u8; 4] = [127, 0, 0, 1];

fn gateway_port_from_env(desktop_port: Option<&str>, paas_port: Option<&str>) -> u16 {
    desktop_port
        .or(paas_port)
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(DEFAULT_GATEWAY_PORT)
}

fn gateway_host_from_env(host: Option<&str>) -> IpAddr {
    host.and_then(|value| value.trim().parse().ok())
        .unwrap_or(IpAddr::from(DEFAULT_GATEWAY_HOST))
}

pub(crate) fn gateway_bind_addr() -> SocketAddr {
    let port = gateway_port_from_env(
        env::var("HOMUN_DESKTOP_GATEWAY_PORT").ok().as_deref(),
        env::var("PORT").ok().as_deref(), // PaaS convention.
    );
    let host = gateway_host_from_env(env::var("HOMUN_DESKTOP_GATEWAY_HOST").ok().as_deref());
    SocketAddr::from((host, port))
}

#[cfg(test)]
mod tests {
    use super::{gateway_host_from_env, gateway_port_from_env};

    #[test]
    fn desktop_port_override_wins_over_paas_port() {
        assert_eq!(gateway_port_from_env(Some("19000"), Some("20000")), 19_000);
    }

    #[test]
    fn paas_port_is_used_when_desktop_port_is_absent() {
        assert_eq!(gateway_port_from_env(None, Some("20000")), 20_000);
    }

    #[test]
    fn invalid_ports_fall_back_to_default_gateway_port() {
        assert_eq!(gateway_port_from_env(Some("bad"), Some("20000")), 18_765);
        assert_eq!(gateway_port_from_env(None, Some("bad")), 18_765);
    }

    #[test]
    fn host_defaults_to_loopback_unless_a_valid_override_is_supplied() {
        assert_eq!(gateway_host_from_env(None).to_string(), "127.0.0.1");
        assert_eq!(
            gateway_host_from_env(Some(" 0.0.0.0 ")).to_string(),
            "0.0.0.0"
        );
        assert_eq!(gateway_host_from_env(Some("bad")).to_string(), "127.0.0.1");
    }
}

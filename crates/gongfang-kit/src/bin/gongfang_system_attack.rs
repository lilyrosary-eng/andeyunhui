//! 体系攻击 + 反追踪真实能力测试器（用软件自身 reqwest + stealth UA）
//! A) 反追踪真实测：直连 vs 经代理A/B egress 轮换 + XFF 混淆 → 目标看到的出口
//! B) 体系攻击：打 /api/system（要求 IP 隐藏）→ 未隐藏者 L2 被 403 拦，隐藏者穿到 flag
use serde_json::Value;
use std::time::{Duration, Instant};

// ---- 低轮换率策略：出口持有 ≥ churn 窗口时才允许轮换 ----
struct EgressManager {
    proxies: Vec<String>,
    idx: usize,
    started: Instant,
    min_hold: Duration,
}
impl EgressManager {
    fn new(proxies: Vec<String>, min_hold: Duration) -> Self {
        Self { proxies, idx: 0, started: Instant::now(), min_hold }
    }
    /// 只有达到 min_hold 才自动轮换（否则维持当前出口 → 滑动窗内 distinct 保持 ≤1）
    fn current_url(&mut self) -> String {
        if self.started.elapsed() >= self.min_hold { self.force_rotate(); }
        self.proxies[self.idx].clone()
    }
    fn force_rotate(&mut self) {
        self.idx = (self.idx + 1) % self.proxies.len();
        self.started = Instant::now();
    }
}

fn sha1_hex(input: &str) -> String {
    let mut data = input.as_bytes().to_vec();
    let len_bits = (data.len() as u64) * 8;
    data.push(0x80);
    while data.len() % 64 != 56 { data.push(0); }
    data.extend_from_slice(&len_bits.to_be_bytes());
    let mut h = [0x67452301u32, 0xEFCDAB89, 0x98BADCFE, 0x10325476, 0xC3D2E1F0];
    for chunk in data.chunks(64) {
        let mut w = [0u32; 80];
        for i in 0..16 { w[i] = u32::from_be_bytes([chunk[i*4], chunk[i*4+1], chunk[i*4+2], chunk[i*4+3]]); }
        for i in 16..80 { w[i] = (w[i-3] ^ w[i-8] ^ w[i-14] ^ w[i-16]).rotate_left(1); }
        let (mut a, mut b, mut c, mut d, mut e) = (h[0], h[1], h[2], h[3], h[4]);
        for i in 0..80 {
            let (f, k) = match i { 0..=19 => ((b & c) | ((!b) & d), 0x5A827999u32), 20..=39 => (b ^ c ^ d, 0x6ED9EBA1), 40..=59 => ((b & c) | (b & d) | (c & d), 0x8F1BBCDC), _ => (b ^ c ^ d, 0xCA62C1D6) };
            let tmp = a.rotate_left(5).wrapping_add(f).wrapping_add(e).wrapping_add(k).wrapping_add(w[i]);
            e = d; d = c; c = b.rotate_left(30); b = a; a = tmp;
        }
        h[0]=h[0].wrapping_add(a); h[1]=h[1].wrapping_add(b); h[2]=h[2].wrapping_add(c); h[3]=h[3].wrapping_add(d); h[4]=h[4].wrapping_add(e);
    }
    h.iter().map(|x| format!("{x:08x}")).collect()
}

fn ua() -> String {
    #[cfg(feature = "crawler")]
    { gongfang_kit::crawler::stealth::user_agent("chrome_122").to_string() }
    #[cfg(not(feature = "crawler"))]
    { "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36".to_string() }
}

fn client(proxy: Option<&str>) -> reqwest::Client {
    let mut b = reqwest::Client::builder().timeout(std::time::Duration::from_secs(15));
    if let Some(p) = proxy {
        b = b.proxy(reqwest::Proxy::http(p).expect("proxy"));
    }
    b.build().expect("client")
}

async fn post(c: &reqwest::Client, url: &str, sign: Option<&str>, xff: Option<&str>, body: &str) -> (u16, Value) {
    let mut h = reqwest::header::HeaderMap::new();
    h.insert("content-type", "application/json".parse().unwrap());
    h.insert("user-agent", ua().parse().unwrap());
    if let Some(s) = sign { h.insert("x-sign", s.parse().unwrap()); }
    if let Some(x) = xff { h.insert("x-forwarded-for", x.parse().unwrap()); }
    let r = c.post(url).headers(h).body(body.to_string()).send().await;
    match r {
        Ok(rr) => { let code = rr.status().as_u16(); let txt = rr.text().await.unwrap_or_default(); let v = serde_json::from_str(&txt).unwrap_or(Value::Null); (code, v) }
        Err(e) => (0, serde_json::json!({ "error": e.to_string() })),
    }
}

async fn ip_echo(c: &reqwest::Client, base: &str, xff: Option<&str>) -> (u16, Value) {
    post(c, &format!("{base}/api/ip-echo"), None, xff, "{}").await
}

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let base = std::env::args().nth(1).unwrap_or_else(|| "http://127.0.0.1:8787".to_string());
    let c_direct = client(None);
    let c_proxyA = client(Some("http://127.0.0.2:8798"));
    let c_proxyB = client(Some("http://127.0.0.3:8799"));

    println!("===== A) 反追踪真实能力：出口 IP 观测 =====");
    let (_, v0) = ip_echo(&c_direct, &base, None).await;
    let (_, vA) = ip_echo(&c_proxyA, &base, None).await;
    let (_, vB) = ip_echo(&c_proxyB, &base, None).await;
    let (_, vX) = ip_echo(&c_direct, &base, Some("203.0.113.7, 198.51.100.4")).await;
    println!(" 直连   -> 目标看到的出口: {}", v0["remote"].as_str().unwrap_or("") );
    println!(" 代理A  -> 目标看到的出口: {}   (已替换真实IP)", vA["remote"].as_str().unwrap_or(""));
    println!(" 代理B  -> 目标看到的出口: {}   (轮换,防一致性追踪)", vB["remote"].as_str().unwrap_or(""));
    println!(" XFF混淆-> 目标看到的出口: {}, XFF: {}", vX["remote"].as_str().unwrap_or(""), vX["xff"].as_str().unwrap_or(""));

    println!("\n===== B) 体系攻击 /api/system（要求 IP 隐藏） =====");
    // B1: 直连(未隐藏) → 应在 L2 被 403
    println!("  B1 直连(不隐藏IP):");
    let (cb, vb) = post(&c_direct, &format!("{base}/api/system/begin"), None, None, "{}").await;
    let btoken = vb["token"].as_str().unwrap_or("").to_string();
    println!("    begin -> {cb} hidden_seen={}", vb["hidden_seen"].as_bool().unwrap_or(false));
    let sign2 = sha1_hex(&format!("fortress-shell-secret:{btoken}:2"));
    let (c2, v2) = post(&c_direct, &format!("{base}/api/system/step"), Some(&sign2), None, &format!(r#"{{"token":"{btoken}","layer":2}}"#)).await;
    println!("    L2(direct) -> {c2} {} (预期 403:未隐藏)", v2["error"].as_str().unwrap_or(""));

    // B2: 经代理A(隐藏) → 穿到 flag
    println!("  B2 经代理(IP已隐藏):");
    // 等频控冷却
    tokio::time::sleep(std::time::Duration::from_secs(10)).await;
    let (_, va) = post(&c_proxyA, &format!("{base}/api/system/begin"), None, None, "{}").await;
    let atoken = va["token"].as_str().unwrap_or("").to_string();
    println!("    begin -> hidden_seen={}", va["hidden_seen"].as_bool().unwrap_or(false));
    tokio::time::sleep(std::time::Duration::from_millis(2500)).await;
    for claim in 1u32..=5 {
        let sign = sha1_hex(&format!("fortress-shell-secret:{atoken}:{claim}"));
        let mut body = format!(r#"{{"token":"{atoken}","layer":{claim}"#);
        if claim >= 3 { body.push_str(r#","behavior":0.38"#); }
        if claim >= 4 { body.push_str(",\"fp\":\"fp-ABCDEFGHIJKLMNOP\""); }
        body.push('}');
        let (code, v) = post(&c_proxyA, &format!("{base}/api/system/step"), Some(&sign), None, &body).await;
        let flag = v["flag"].as_str().unwrap_or("");
        let err = v["error"].as_str().unwrap_or("");
        println!("    L{claim} -> {code} {}{}", if !flag.is_empty() { format!("FLAG={flag}") } else if !err.is_empty() { format!("ERR={err}") } else { String::new() }, "");
        if !flag.is_empty() || code != 200 { break; }
        tokio::time::sleep(std::time::Duration::from_millis(2500)).await;
    }

    println!("\n===== C) 体系识破能力：IP 变化一致性计数 =====");
    // 攻击者：保持同一身份(cid=fp)但轮换出口 → distinct 应被体系数出并判"识破"
    let cid = "fp-ATTACKER-ROTATE";
    let probes = [("直连(.1)", &c_direct), ("代理A(.2)", &c_proxyA), ("代理B(.3)", &c_proxyB)];
    for (label, c) in probes {
        let (_, v) = post(c, &format!("{base}/api/system/churn"), None, None, &format!(r#"{{"cid":"{cid}"}}"#)).await;
        println!("  [轮换攻击者] {label} -> distinct_ips={} 出口={} → {}", v["distinct_ips"], v["seen_ip"].as_str().unwrap_or(""), v["verdict"].as_str().unwrap_or(""));
    }
    // 稳定用户：单一出口 → 体系判"一致"
    let ucid = "fp-NORMAL-USER";
    for (label, c) in [("直连(.1)", &c_direct), ("直连(.1)", &c_direct)] {
        let (_, v) = post(c, &format!("{base}/api/system/churn"), None, None, &format!(r#"{{"cid":"{ucid}"}}"#)).await;
        println!("  [稳定用户] {label} -> distinct_ips={} → {}", v["distinct_ips"], v["verdict"].as_str().unwrap_or(""));
    }

    println!("\n===== D) 反追踪对抗：低轮换率策略（漏过一致性识破） =====");
    // 攻击者改用"低轮换率"：出口持有 ≥ churn 窗口(60s) 才允许切换
    // → 任意时刻滑动窗内只有 ≤1 个 distinct → 体系永远判"一致"，即便轮换了也没被识破。
    let hold_ms = std::env::args().find(|a| a.starts_with("--hold="))
        .and_then(|a| a.trim_start_matches("--hold=").parse::<u64>().ok())
        .unwrap_or(62000);
    let mut egress = EgressManager::new(
        vec!["http://127.0.0.2:8798".to_string(), "http://127.0.0.3:8799".to_string()],
        Duration::from_secs(65), // min_hold > churn 窗口 60s
    );
    let cid = "fp-ROTATE-SLOW";
    let c_hold = client(Some(&egress.current_url()));
    let (_, v1) = post(&c_hold, &format!("{base}/api/system/churn"), None, None, &format!(r#"{{"cid":"{cid}"}}"#)).await;
    println!("  t0 持有出口({}) -> distinct={} → {}", v1["seen_ip"].as_str().unwrap_or(""), v1["distinct_ips"], v1["verdict"].as_str().unwrap_or(""));
    println!("  持有中(min_hold=65s ≥ 窗口60s，暂不轮换)…");
    tokio::time::sleep(Duration::from_millis(hold_ms)).await;
    // 达到持有期后做一次"合规"轮换
    egress.force_rotate();
    let c_rot = client(Some(&egress.current_url()));
    let (_, v2) = post(&c_rot, &format!("{base}/api/system/churn"), None, None, &format!(r#"{{"cid":"{cid}"}}"#)).await;
    println!("  t1 轮换后出口({}) -> distinct={} → {} （旧出口已滑出窗口→判一致=漏过识破）", v2["seen_ip"].as_str().unwrap_or(""), v2["distinct_ips"], v2["verdict"].as_str().unwrap_or(""));
}
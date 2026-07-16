//! 加密算法识别（卡方检验 + 已知算法特征向量库）
//!
//! 对应逆向细化维度三：白盒加密代数击穿的务实降级版。
//!
//! 替代原方案（桌面不可行）：
//! - DFA 差分故障分析（需硬件故障注入）→ 删除
//! - Gröbner基/SAT求解器（实现复杂，Python依赖重）→ 删除
//! - 香农差分分布表 → 降级为卡方检验
//!
//! 务实实现：
//! - 卡方检验：检测密文字节分布是否均匀（标准加密应均匀分布）
//!   * 卡方值大 → 非均匀分布 → 非标准加密或编码（Base64/Hex 等）
//!   * 卡方值小 → 均匀分布 → 标准加密（AES-CBC 等）
//! - 已知算法特征向量库：用汉明距离匹配最接近的算法
//!   * project_memory 硬约束："差分神经网络猜 S 盒→已知加密算法特征向量库匹配（汉明距离）"
//!   * 特征向量：S盒汉明重量分布、块大小、轮数、密文熵值

use serde::{Deserialize, Serialize};

/// 卡方检验结果
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChiSquareResult {
    /// 卡方统计量
    pub chi_square: f64,
    /// 自由度（255，256 字节 - 1）
    pub degrees_of_freedom: usize,
    /// p 值（近似，<0.05 表示非均匀分布）
    pub p_value_approx: f64,
    /// 判定：是否为非均匀分布（可能非标准加密）
    pub is_non_uniform: bool,
}

/// 对密文进行卡方检验
///
/// 原理：标准加密（AES-CBC）的密文字节应均匀分布，
/// 期望频率 = 总字节数 / 256。卡方值大 → 非均匀 → 非标准加密。
pub fn chi_square_test(ciphertext: &[u8]) -> ChiSquareResult {
    if ciphertext.is_empty() {
        return ChiSquareResult {
            chi_square: 0.0,
            degrees_of_freedom: 255,
            p_value_approx: 1.0,
            is_non_uniform: false,
        };
    }

    // 统计字节频率
    let mut freq = vec![0u64; 256];
    for &b in ciphertext {
        freq[b as usize] += 1;
    }

    // 期望频率
    let total = ciphertext.len() as f64;
    let expected = total / 256.0;

    // 卡方统计量 = Σ (观察值 - 期望值)² / 期望值
    let chi_square: f64 = freq
        .iter()
        .map(|&obs| {
            let diff = obs as f64 - expected;
            diff * diff / expected
        })
        .sum();

    // p 值近似（卡方分布，自由度 255）
    // 简化：卡方值 > 300 大致对应 p < 0.05（255 自由度）
    // 严格计算需要不完全伽马函数，桌面场景近似足够
    let p_value_approx = if chi_square < 200.0 {
        0.95 // 高度均匀（标准加密）
    } else if chi_square < 300.0 {
        0.10 // 边界
    } else if chi_square < 400.0 {
        0.01 // 非均匀
    } else {
        0.001 // 高度非均匀（非标准加密/编码）
    };

    ChiSquareResult {
        chi_square,
        degrees_of_freedom: 255,
        p_value_approx,
        is_non_uniform: p_value_approx < 0.05,
    }
}

/// 加密算法特征向量
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CryptoFingerprint {
    /// 算法名称
    pub name: String,
    /// 块大小（字节）
    pub block_size: usize,
    /// 轮数
    pub rounds: usize,
    /// S 盒汉明重量分布（256 维向量，归一化）
    pub sbox_hamming_weight: Vec<f64>,
    /// 典型密文熵值范围
    pub entropy_range: (f64, f64),
}

/// 已知算法特征向量库
///
/// project_memory 硬约束："差分神经网络猜 S 盒→已知加密算法特征向量库匹配（汉明距离）"
/// 替代 DFA/Gröbner：用特征向量汉明距离匹配，零依赖
pub struct FingerprintLibrary {
    fingerprints: Vec<CryptoFingerprint>,
}

impl FingerprintLibrary {
    pub fn new() -> Self {
        Self {
            fingerprints: vec![
                CryptoFingerprint {
                    name: "AES-128-CBC".to_string(),
                    block_size: 16,
                    rounds: 10,
                    sbox_hamming_weight: aes_sbox_hamming_weights(),
                    entropy_range: (7.9, 8.0),
                },
                CryptoFingerprint {
                    name: "AES-256-CBC".to_string(),
                    block_size: 16,
                    rounds: 14,
                    sbox_hamming_weight: aes_sbox_hamming_weights(),
                    entropy_range: (7.9, 8.0),
                },
                CryptoFingerprint {
                    name: "DES-ECB".to_string(),
                    block_size: 8,
                    rounds: 16,
                    sbox_hamming_weight: des_sbox_hamming_weights(),
                    entropy_range: (7.5, 8.0),
                },
                CryptoFingerprint {
                    name: "SM4-CBC".to_string(),
                    block_size: 16,
                    rounds: 32,
                    sbox_hamming_weight: sm4_sbox_hamming_weights(),
                    entropy_range: (7.9, 8.0),
                },
                CryptoFingerprint {
                    name: "ChaCha20".to_string(),
                    block_size: 64,
                    rounds: 20,
                    sbox_hamming_weight: vec![],
                    entropy_range: (7.9, 8.0),
                },
                CryptoFingerprint {
                    name: "Base64".to_string(),
                    block_size: 3,
                    rounds: 0,
                    sbox_hamming_weight: vec![],
                    entropy_range: (5.5, 6.0),
                },
                CryptoFingerprint {
                    name: "Hex".to_string(),
                    block_size: 1,
                    rounds: 0,
                    sbox_hamming_weight: vec![],
                    entropy_range: (3.5, 4.0),
                },
            ],
        }
    }

    /// 匹配最接近的算法（汉明距离最小）
    ///
    /// 输入：观测到的特征（块大小、密文熵、S盒汉明重量）
    /// 输出：匹配的算法名 + 置信度
    pub fn match_fingerprint(
        &self,
        block_size: Option<usize>,
        entropy: f64,
        sbox_hamming: Option<&[f64]>,
    ) -> Option<(String, f64)> {
        let mut best: Option<(String, f64)> = None;

        for fp in &self.fingerprints {
            let mut score = 0.0;

            // 块大小匹配
            if let Some(bs) = block_size {
                if bs == fp.block_size {
                    score += 30.0;
                } else if bs % fp.block_size == 0 || fp.block_size % bs == 0 {
                    score += 10.0;
                }
            }

            // 熵值匹配
            if entropy >= fp.entropy_range.0 && entropy <= fp.entropy_range.1 {
                score += 40.0;
            } else {
                let dist = ((entropy - fp.entropy_range.0).abs())
                    .min((entropy - fp.entropy_range.1).abs());
                score += (40.0 - dist * 10.0).max(0.0);
            }

            // S 盒汉明重量距离
            if let Some(observed_sbox) = sbox_hamming {
                if !fp.sbox_hamming_weight.is_empty()
                    && observed_sbox.len() == fp.sbox_hamming_weight.len()
                {
                    let distance: f64 = observed_sbox
                        .iter()
                        .zip(fp.sbox_hamming_weight.iter())
                        .map(|(a, b)| (a - b).abs())
                        .sum();
                    // 距离越小分数越高（最大距离 ~256，归一化到 0-30）
                    score += (30.0 * (1.0 - distance / 256.0)).max(0.0);
                }
            }

            let confidence = (score / 100.0).min(1.0);
            match best {
                None => best = Some((fp.name.clone(), confidence)),
                Some((_, c)) if confidence > c => best = Some((fp.name.clone(), confidence)),
                _ => {}
            }
        }

        best
    }
}

impl Default for FingerprintLibrary {
    fn default() -> Self {
        Self::new()
    }
}

/// 计算数据的香农熵
pub fn shannon_entropy(data: &[u8]) -> f64 {
    if data.is_empty() {
        return 0.0;
    }
    let mut freq = vec![0u64; 256];
    for &b in data {
        freq[b as usize] += 1;
    }
    let total = data.len() as f64;
    let mut entropy = 0.0;
    for &count in &freq {
        if count > 0 {
            let p = count as f64 / total;
            entropy -= p * p.log2();
        }
    }
    entropy
}

// === 已知 S 盒汉明重量分布（预计算） ===

fn hamming_weights(sbox: &[u8]) -> Vec<f64> {
    let mut weights = vec![0u64; 9]; // 0-8 位
    for &b in sbox {
        let w = b.count_ones() as usize;
        weights[w] += 1;
    }
    weights.iter().map(|&c| c as f64 / sbox.len() as f64).collect()
}

fn aes_sbox_hamming_weights() -> Vec<f64> {
    hamming_weights(&[
        0x63, 0x7c, 0x77, 0x7b, 0xf2, 0x6b, 0x6f, 0xc5, 0x30, 0x01, 0x67, 0x2b, 0xfe, 0xd7, 0xab, 0x76,
        0xca, 0x82, 0xc9, 0x7d, 0xfa, 0x59, 0x47, 0xf0, 0xad, 0xd4, 0xa2, 0xaf, 0x9c, 0xa4, 0x72, 0xc0,
        // ... 完整 AES S 盒 256 字节，此处截断前 32 字节作为特征样本
        // 实际使用时填充完整 S 盒
    ])
}

fn des_sbox_hamming_weights() -> Vec<f64> {
    // DES 8 个 S 盒的汉明重量分布（简化）
    vec![0.0, 0.008, 0.039, 0.109, 0.219, 0.273, 0.219, 0.109, 0.024]
}

fn sm4_sbox_hamming_weights() -> Vec<f64> {
    hamming_weights(&[
        0xd6, 0x90, 0xe9, 0xfe, 0xcc, 0xe1, 0x3d, 0xb7, 0x16, 0xb6, 0x14, 0xc2, 0x28, 0xfb, 0x2c, 0x05,
        0x2b, 0x67, 0x9a, 0x76, 0x2a, 0xbe, 0x04, 0xc3, 0xaa, 0x44, 0x13, 0x26, 0x49, 0x86, 0x06, 0x99,
        // SM4 S 盒前 32 字节样本
    ])
}

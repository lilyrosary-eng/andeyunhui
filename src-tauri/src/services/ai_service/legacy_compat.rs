// v2 ↔ v1 双向派生。存在的唯一理由：ai_get_profiles / ai_set_profiles /
// ai_set_profile_thinking 三个命令被 13 处前端调用（其中 4 处在插件里，
// 走 pluginSandbox.ts:199-200,219 的白名单），直接换成 v2 形状是 breaking。
// 保住这三个命令，插件 / 胶囊 / 移动端 / 语义记忆 / 思考开关全部零改动。

use super::ai_profile::{
    default_temperature, provider_id_for, AiConfig, AiProfile, AiProfiles, Caps, ModelEntry,
    Overrides, Provider, Selection,
};

/// v2 → v1 形状。id 直接沿用 ModelEntry.id，所以 v1/v2 是同一套 id 体系。
pub fn to_legacy_profiles(config: &AiConfig) -> AiProfiles {
    let mut profiles = Vec::new();
    for prov in &config.providers {
        for m in &prov.models {
            let o = &m.overrides;
            profiles.push(AiProfile {
                id: m.id.clone(),
                name: m.label.clone().unwrap_or_else(|| m.model.clone()),
                base_url: prov.base_url.clone(),
                api_key: prov.api_key.clone(),
                model: m.model.clone(),
                vision_model: prov.vision_model.clone(),
                temperature: o.temperature.unwrap_or_else(default_temperature),
                max_tokens: o.max_tokens,
                top_p: o.top_p,
                system_prompt: o.system_prompt.clone(),
                thinking: o.thinking,
                persona_call_me_as: o.persona_call_me_as.clone(),
                persona_preset: o.persona_preset.clone(),
                persona_style: o.persona_style.clone(),
                image_model: prov.image_model.clone(),
                tts_model: prov.tts_model.clone(),
                max_context_tokens: o.max_context_tokens.or(m.context_tokens),
            });
        }
    }
    AiProfiles {
        profiles,
        active: config.selection.model_id.clone(),
    }
}

/// v1 → v2 形状：把 payload **合并**进 existing，按 (base_url, api_key) 分组。
///
/// 为什么必须带 existing：移动端（useAiStream.ts:126 调 ai_set_profiles）与思考开关
/// 都可能只带着一条档案回来。只看 payload 的话，同供应商下用户没动过的其他模型会被
/// 悄悄删掉——而且这个删除不可见，用户要等到下次调那个模型报「未找到档案」才发现。
///
/// 合并规则：
/// - **payload 提到的条目以 payload 为准**（否则用户在旧客户端里的编辑等于没保存）
/// - **payload 没提到的条目一律保留**（v1 形状表达不了「这个模型还在，只是这次没提到它」）
/// - **v1 表达不了的字段（caps / context_tokens）保留 existing 的值**：v1 形状里没有这两个
///   字段，整条替换条目等于旧客户端每保存一次就把用户手动修正的能力标记清零一次
/// - selection 整体覆盖：v1 的 active 是整份文件里的单值，payload 缺它就等于没选中
pub fn from_legacy_profiles(existing: &AiConfig, legacy: &AiProfiles) -> AiConfig {
    let mut cfg = existing.clone();

    for p in &legacy.profiles {
        // 分组键直接用 (base_url, 明文 key) 在 cfg.providers 里定位：本轮新建的供应商
        // 也进了 cfg.providers，所以「组」这件事不需要额外维护一张表。
        // 同端点不同 key 不合并——它们是不同的凭证。
        let idx = match cfg
            .providers
            .iter()
            .position(|prov| prov.base_url == p.base_url && prov.api_key == p.api_key)
        {
            Some(i) => i,
            None => {
                cfg.providers.push(Provider {
                    id: provider_id_for(&p.base_url, &p.api_key),
                    name: p.name.trim().to_string(),
                    base_url: p.base_url.clone(),
                    api_key: p.api_key.clone(),
                    models: Vec::new(),
                    // 三件套一律置 None，统一由下面的「取组内首个非空值」逻辑填
                    vision_model: None,
                    image_model: None,
                    tts_model: None,
                    last_scanned_at: None,
                });
                cfg.providers.len() - 1
            }
        };
        let prov = &mut cfg.providers[idx];
        // 供应商级的三件套取组内首个非空值，判据与 migrate_v1_to_v2 一致
        if prov.vision_model.is_none() {
            prov.vision_model = p.vision_model.clone();
        }
        if prov.image_model.is_none() {
            prov.image_model = p.image_model.clone();
        }
        if prov.tts_model.is_none() {
            prov.tts_model = p.tts_model.clone();
        }
        let entry = ModelEntry {
            id: p.id.clone(),
            model: p.model.clone(),
            label: if p.name.trim().is_empty() {
                None
            } else {
                Some(p.name.trim().to_string())
            },
            caps: Caps {
                text: true,
                vision: p.vision_model.as_deref() == Some(p.model.as_str()),
                ..Default::default()
            },
            context_tokens: None,
            max_output_tokens: None,
            overrides: Overrides {
                temperature: Some(p.temperature),
                max_tokens: p.max_tokens,
                top_p: p.top_p,
                system_prompt: p.system_prompt.clone(),
                thinking: p.thinking,
                persona_call_me_as: p.persona_call_me_as.clone(),
                persona_preset: p.persona_preset.clone(),
                persona_style: p.persona_style.clone(),
                max_context_tokens: p.max_context_tokens,
            },
        };
        match prov.models.iter_mut().find(|m| m.id == entry.id) {
            Some(found) => {
                found.model = entry.model;
                found.label = entry.label;
                found.overrides = entry.overrides;
                // caps / context_tokens 保持不动，见函数注释
            }
            None => prov.models.push(entry),
        }
    }

    if let Some(active) = &legacy.active {
        if let Some(prov) = cfg
            .providers
            .iter()
            .find(|p| p.models.iter().any(|m| &m.id == active))
        {
            cfg.selection = Selection {
                provider_id: Some(prov.id.clone()),
                model_id: Some(active.clone()),
            };
            return cfg;
        }
    }
    cfg.selection = Selection::default();
    cfg
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_cfg() -> AiConfig {
        serde_json::from_value(serde_json::json!({
            "providers": [{
                "id": "pv_1", "name": "本地", "base_url": "http://127.0.0.1:11434/v1",
                "api_key": "sk-x", "vision_model": "qwen-vl",
                "models": [
                    { "id": "p_aaa", "model": "qwen3:8b",
                      "overrides": { "temperature": 0.5, "max_tokens": 4096, "thinking": true } },
                    { "id": "p_bbb", "model": "llama3" }
                ]
            }],
            "selection": { "provider_id": "pv_1", "model_id": "p_bbb" }
        })).unwrap()
    }

    #[test]
    fn 派生_v2到v1() {
        let legacy = to_legacy_profiles(&sample_cfg());
        assert_eq!(legacy.profiles.len(), 2);
        assert_eq!(legacy.active.as_deref(), Some("p_bbb"));
        let a = legacy.profiles.iter().find(|p| p.id == "p_aaa").unwrap();
        assert_eq!(a.model, "qwen3:8b");
        assert_eq!(a.base_url, "http://127.0.0.1:11434/v1");
        assert_eq!(a.api_key, "sk-x");
        assert_eq!(a.vision_model.as_deref(), Some("qwen-vl"));
        assert!((a.temperature - 0.5).abs() < f32::EPSILON);
        assert_eq!(a.max_tokens, Some(4096));
        assert_eq!(a.thinking, Some(true));
    }

    #[test]
    fn 派生_v2到v1_名称回落模型名() {
        let legacy = to_legacy_profiles(&sample_cfg());
        let b = legacy.profiles.iter().find(|p| p.id == "p_bbb").unwrap();
        assert_eq!(b.name, "llama3");
    }

    #[test]
    fn 派生_v2到v1_温度缺省补03() {
        let legacy = to_legacy_profiles(&sample_cfg());
        let b = legacy.profiles.iter().find(|p| p.id == "p_bbb").unwrap();
        assert!((b.temperature - 0.3).abs() < f32::EPSILON);
    }

    #[test]
    fn 回流_v1到v2_同端点同key合并() {
        let legacy = AiProfiles {
            profiles: vec![
                AiProfile { id: "x1".into(), base_url: "http://a/v1".into(), api_key: "k".into(), model: "m1".into(), ..Default::default() },
                AiProfile { id: "x2".into(), base_url: "http://a/v1".into(), api_key: "k".into(), model: "m2".into(), ..Default::default() },
            ],
            active: Some("x2".into()),
        };
        let cfg = from_legacy_profiles(&AiConfig::default(), &legacy);
        assert_eq!(cfg.providers.len(), 1);
        assert_eq!(cfg.providers[0].models.len(), 2);
        assert_eq!(cfg.selection.model_id.as_deref(), Some("x2"));
    }

    #[test]
    fn 回流_v1到v2_不同key不合并() {
        let legacy = AiProfiles {
            profiles: vec![
                AiProfile { id: "x1".into(), base_url: "http://a/v1".into(), api_key: "k1".into(), model: "m1".into(), ..Default::default() },
                AiProfile { id: "x2".into(), base_url: "http://a/v1".into(), api_key: "k2".into(), model: "m2".into(), ..Default::default() },
            ],
            active: None,
        };
        assert_eq!(from_legacy_profiles(&AiConfig::default(), &legacy).providers.len(), 2);
    }

    #[test]
    fn 回流_保留同供应商下未被payload提到的模型() {
        // 移动端只编辑了一条档案，不能把同供应商的其他模型悄悄删掉
        let mut cfg = sample_cfg();
        // 先改温度再派生 payload：payload 带的才是用户真正编辑出来的值
        cfg.providers[0].models[0].overrides.temperature = Some(0.9);
        let legacy = to_legacy_profiles(&cfg);
        let mut slim = legacy.clone();
        slim.profiles.retain(|p| p.id == "p_aaa");
        let back = from_legacy_profiles(&cfg, &slim);
        assert_eq!(back.providers[0].models.len(), 2, "p_bbb 不该被删");
        assert_eq!(back.providers[0].models[0].overrides.temperature, Some(0.9));
    }

    #[test]
    fn 回流_payload覆盖同id模型的参数() {
        // payload 提到的那条以 payload 为准：否则用户在旧客户端里的编辑等于没保存
        let existing = sample_cfg();
        let mut legacy = to_legacy_profiles(&existing);
        legacy.profiles.iter_mut().find(|p| p.id == "p_aaa").unwrap().temperature = 0.2;
        let back = from_legacy_profiles(&existing, &legacy);
        assert!((back.providers[0].models[0].overrides.temperature.unwrap() - 0.2).abs() < f32::EPSILON);
    }

    #[test]
    fn 回流_保住v1表达不了的caps与上下文长度() {
        // v1 形状里没有 caps / context_tokens。若整条替换条目，
        // 旧客户端每保存一次就把用户手动修正的能力标记和端点发现的上下文长度清零。
        let mut existing = sample_cfg();
        existing.providers[0].models[0].caps.vision = true;
        existing.providers[0].models[0].context_tokens = Some(131_072);
        let back = from_legacy_profiles(&existing, &to_legacy_profiles(&existing));
        assert!(back.providers[0].models[0].caps.vision, "caps 不该被旧客户端的保存清掉");
        assert_eq!(back.providers[0].models[0].context_tokens, Some(131_072));
    }

    #[test]
    fn 回流_供应商三件套取组内首个非空() {
        // 判据与 migrate_v1_to_v2 一致：同供应商下多条档案各填各的时不能只看第一条
        let legacy = AiProfiles {
            profiles: vec![
                AiProfile { id: "x1".into(), name: "甲".into(), base_url: "http://a/v1".into(), api_key: "k".into(), model: "m1".into(), ..Default::default() },
                AiProfile { id: "x2".into(), base_url: "http://a/v1".into(), api_key: "k".into(), model: "m2".into(),
                            image_model: Some("sd3".into()), tts_model: Some("tts-1".into()), ..Default::default() },
            ],
            active: None,
        };
        let cfg = from_legacy_profiles(&AiConfig::default(), &legacy);
        assert_eq!(cfg.providers.len(), 1);
        assert_eq!(cfg.providers[0].image_model.as_deref(), Some("sd3"));
        assert_eq!(cfg.providers[0].tts_model.as_deref(), Some("tts-1"));
    }

    #[test]
    fn 往返_模型集合与selection不变() {
        let cfg = sample_cfg();
        let back = from_legacy_profiles(&cfg, &to_legacy_profiles(&cfg));
        let ids_a: Vec<&str> = cfg.providers.iter().flat_map(|p| p.models.iter().map(|m| m.id.as_str())).collect();
        let ids_b: Vec<&str> = back.providers.iter().flat_map(|p| p.models.iter().map(|m| m.id.as_str())).collect();
        assert_eq!(ids_a, ids_b);
        assert_eq!(back.selection.model_id, cfg.selection.model_id);
    }
}

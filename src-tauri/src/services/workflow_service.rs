use std::fs;
use std::path::PathBuf;
use serde::{Deserialize, Serialize};

/// 一期 AIWorkflow 后端数据层：蓝图持久化 + 执行日志。
/// 采用"目录 + 单个 JSON 文件"的扁平结构（无数据库），便于导出 / 复用 / 审计。
///
/// 目录布局（均在 app_data_dir 下）：
///   workflows/          —— 工作流蓝图定义（flowId.json）
///   workflow_runs/      —— 执行日志（runId.json，含基本信息 + 步骤数组）

fn workflows_dir(root: &PathBuf) -> PathBuf {
    root.join("workflows")
}

fn runs_dir(root: &PathBuf) -> PathBuf {
    root.join("workflow_runs")
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowMeta {
    pub id: String,
    pub name: String,
    pub updated_at: String,
}

/// 保存或更新一份蓝图。json 为前端提交的蓝图定义（任意 JSON）。
pub fn save_workflow(root: &PathBuf, flow_id: &str, name: &str, json: &serde_json::Value) -> Result<(), String> {
    let dir = workflows_dir(root);
    fs::create_dir_all(&dir).map_err(|e| format!("创建 workflows 目录失败: {}", e))?;
    let path = dir.join(format!("{}.json", flow_id));
    let payload = serde_json::json!({
        "id": flow_id,
        "name": name,
        "updatedAt": chrono::Utc::now().to_rfc3339(),
        "flow": json,
    });
    fs::write(&path, serde_json::to_string_pretty(&payload).map_err(|e| format!("序列化蓝图失败: {}", e))?)
        .map_err(|e| format!("写入蓝图失败: {}", e))
}

pub fn get_workflow(root: &PathBuf, flow_id: &str) -> Result<serde_json::Value, String> {
    let dir = workflows_dir(root);
    let path = dir.join(format!("{}.json", flow_id));
    if !path.exists() {
        return Err(format!("工作流 {} 不存在", flow_id));
    }
    let content = fs::read_to_string(&path).map_err(|e| format!("读取蓝图失败: {}", e))?;
    serde_json::from_str(&content).map_err(|e| format!("解析蓝图失败: {}", e))
}

pub fn list_workflows(root: &PathBuf) -> Result<Vec<WorkflowMeta>, String> {
    let dir = workflows_dir(root);
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let mut metas: Vec<WorkflowMeta> = Vec::new();
    for entry in fs::read_dir(&dir).map_err(|e| format!("读取 workflows 目录失败: {}", e))?.flatten() {
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }
        let Ok(content) = fs::read_to_string(&path) else { continue };
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&content) else { continue };
        let id = v.get("id").and_then(|x| x.as_str()).unwrap_or_default().to_string();
        let name = v.get("name").and_then(|x| x.as_str()).unwrap_or_default().to_string();
        let updated_at = v
            .get("updatedAt")
            .and_then(|x| x.as_str())
            .unwrap_or_default()
            .to_string();
        if !id.is_empty() {
            metas.push(WorkflowMeta { id, name, updated_at });
        }
    }
    metas.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(metas)
}

pub fn delete_workflow(root: &PathBuf, flow_id: &str) -> Result<(), String> {
    let dir = workflows_dir(root);
    let path = dir.join(format!("{}.json", flow_id));
    if path.exists() {
        fs::remove_file(&path).map_err(|e| format!("删除蓝图失败: {}", e))?;
    }
    Ok(())
}

/// 追加一条步骤日志到指定 run。若 run 不存在则先创建（runId 作文件主键，首条即代表运行开始）。
pub fn append_run_log(root: &PathBuf, run_id: &str, node_label: &str, status: &str, detail: &str) -> Result<(), String> {
    let dir = runs_dir(root);
    fs::create_dir_all(&dir).map_err(|e| format!("创建 workflow_runs 目录失败: {}", e))?;
    let path = dir.join(format!("{}.json", run_id));
    let mut data = if path.exists() {
        fs::read_to_string(&path)
            .ok()
            .and_then(|c| serde_json::from_str::<serde_json::Value>(&c).ok())
            .unwrap_or_else(|| serde_json::json!({ "runId": run_id, "steps": [] }))
    } else {
        serde_json::json!({ "runId": run_id, "startedAt": chrono::Utc::now().to_rfc3339(), "steps": [] })
    };
    let step = serde_json::json!({
        "ts": chrono::Utc::now().to_rfc3339(),
        "nodeLabel": node_label,
        "status": status,
        "detail": detail,
    });
    let mut steps = data
        .get_mut("steps")
        .and_then(|s| s.as_array_mut())
        .cloned()
        .unwrap_or_default();
    steps.push(step);
    data["steps"] = serde_json::Value::Array(steps);
    fs::write(&path, serde_json::to_string_pretty(&data).map_err(|e| format!("序列化日志失败: {}", e))?)
        .map_err(|e| format!("写入日志失败: {}", e))
}

/// 读取某次运行的全部步骤日志。
pub fn list_run_logs(root: &PathBuf, run_id: &str) -> Result<Vec<serde_json::Value>, String> {
    let dir = runs_dir(root);
    let path = dir.join(format!("{}.json", run_id));
    if !path.exists() {
        return Ok(Vec::new());
    }
    let content = fs::read_to_string(&path).map_err(|e| format!("读取日志失败: {}", e))?;
    let v: serde_json::Value = serde_json::from_str(&content).map_err(|e| format!("解析日志失败: {}", e))?;
    Ok(v.get("steps").and_then(|s| s.as_array()).cloned().unwrap_or_default())
}
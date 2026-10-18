//! ai_tools 子模块 · basic —— 内置小工具：当前时间、计算器
//!
//! 由 ai_tools.rs（5245 行）按工具族机械拆分而来，逻辑零改动。
//! 父模块的 use 导入与共享项经 `use super::*` 取得；这里的顶层项统一 pub(crate)，
//! 由 ai_tools.rs 的 `pub(crate) use <mod>::*` 转出，外部引用路径不变。
#![allow(unused_imports)] //  glob 取父模块导入，按族切分后必有剩余，逐个删只会漏
use super::*;

/// 当前本机时间工具：模型借此把「现在几点/今天日期」这类实时问题交给工具答，避免凭空编造。
pub(crate) struct NowTool;
#[async_trait::async_trait]
impl AiTool for NowTool {
    fn name(&self) -> &'static str {
        "get_current_time"
    }
    fn function_schema(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "function",
            "function": {
                "name": self.name(),
                "description": "获取当前时刻（本机时区）。当用户询问『现在几点』『今天几号』『什么时候了』时调用。",
                "parameters": { "type": "object", "properties": {} }
            }
        })
    }
    async fn execute(&self, _args: &serde_json::Value, _ctx: &ToolContext) -> Result<ToolExecResult, String> {
        Ok(ToolExecResult::plain(chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string()))
    }
    fn concurrency(&self) -> ToolConcurrency {
        ToolConcurrency::Parallel
    }
}

/// 安全计算器：仅支持数字与 + - * / ( ) 及一元正负号。递归下降求值，杜绝任意代码执行。
pub(crate) struct CalculatorTool;
#[async_trait::async_trait]
impl AiTool for CalculatorTool {
    fn name(&self) -> &'static str {
        "calculator"
    }
    fn function_schema(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "function",
            "function": {
                "name": self.name(),
                "description": "计算数学表达式。仅支持数字与 + - * / 及括号（如 (12.5+7)*3/2）。需要准确算术时调用。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "expression": { "type": "string", "description": "要计算的数学表达式" }
                    },
                    "required": ["expression"]
                }
            }
        })
    }
    async fn execute(&self, args: &serde_json::Value, _ctx: &ToolContext) -> Result<ToolExecResult, String> {
        let expr = args
            .get("expression")
            .and_then(|v| v.as_str())
            .ok_or("缺少 expression 参数")?;
        let mut p = SafeEval { s: expr, pos: 0 };
        let val = p.parse_expr()?;
        p.skip_ws();
        if p.pos < p.s.len() {
            return Err(format!("表达式存在多余字符: '{}'", &p.s[p.pos..]));
        }
        Ok(ToolExecResult::plain(format!("= {}", val)))
    }
    /// 结果呈现：execute 只回 plain 文本，这里二次结构化为 generic 卡（标题内联防代达式、detail 放结果），
    /// 示范 present_result 独立钩子（对齐 dsh presentResult）：让进度渲染与模型回填文本解耦。
    fn present_result(&self, text: &str, args: &serde_json::Value) -> Option<serde_json::Value> {
        if text.is_empty() {
            return None;
        }
        let expr = args.get("expression").and_then(|v| v.as_str()).unwrap_or("计算");
        Some(serde_json::json!({
            "card": "generic",
            "kind": "other",
            "title": format!("计算 {}", expr),
            "detail": text,
        }))
    }
    fn concurrency(&self) -> ToolConcurrency {
        ToolConcurrency::Parallel
    }
}

/// 极简安全表达式求值器（递归下降）。
pub(crate) struct SafeEval<'a> {
    s: &'a str,
    pos: usize,
}

impl<'a> SafeEval<'a> {
    fn peek(&self) -> Option<char> {
        self.s.get(self.pos..)?.chars().next()
    }
    fn skip_ws(&mut self) {
        while let Some(c) = self.peek() {
            if c.is_ascii_whitespace() {
                self.pos += c.len_utf8();
            } else {
                break;
            }
        }
    }
    fn parse_expr(&mut self) -> Result<f64, String> {
        self.parse_add()
    }
    fn parse_add(&mut self) -> Result<f64, String> {
        let mut v = self.parse_mul()?;
        loop {
            self.skip_ws();
            match self.peek() {
                Some('+') => {
                    self.pos += 1;
                    v += self.parse_mul()?;
                }
                Some('-') => {
                    self.pos += 1;
                    v -= self.parse_mul()?;
                }
                _ => return Ok(v),
            }
        }
    }
    fn parse_mul(&mut self) -> Result<f64, String> {
        let mut v = self.parse_atom()?;
        loop {
            self.skip_ws();
            match self.peek() {
                Some('*') => {
                    self.pos += 1;
                    v *= self.parse_atom()?;
                }
                Some('/') => {
                    self.pos += 1;
                    let d = self.parse_atom()?;
                    if d == 0.0 {
                        return Err("除数为 0".into());
                    }
                    v /= d;
                }
                _ => return Ok(v),
            }
        }
    }
    fn parse_atom(&mut self) -> Result<f64, String> {
        self.skip_ws();
        match self.peek() {
            Some('(') => {
                self.pos += 1;
                let v = self.parse_expr()?;
                self.skip_ws();
                if self.peek() != Some(')') {
                    return Err("缺少右括号".into());
                }
                self.pos += 1;
                Ok(v)
            }
            Some('+') | Some('-') => {
                let sign = if self.peek() == Some('-') { -1.0 } else { 1.0 };
                self.pos += 1;
                Ok(sign * self.parse_atom()?)
            }
            _ => self.parse_number(),
        }
    }
    fn parse_number(&mut self) -> Result<f64, String> {
        self.skip_ws();
        let start = self.pos;
        while let Some(c) = self.peek() {
            if c.is_ascii_digit() || c == '.' {
                self.pos += c.len_utf8();
            } else {
                break;
            }
        }
        let tok = &self.s[start..self.pos];
        if tok.is_empty() {
            return Err("表达式为空".into());
        }
        tok.parse::<f64>()
            .map_err(|_| format!("数字无效: '{}'", tok))
    }
}

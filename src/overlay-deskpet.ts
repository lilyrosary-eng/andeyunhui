// 桌宠浮窗独立入口（对应 deskpet.html）：仅挂载 DeskpetPet，不加载主应用，
// 避免整站 JS 包解析带来的延迟，实现桌宠秒开。
import React from "react";
import ReactDOM from "react-dom/client";
import { DeskpetPet } from "./components/DeskpetPet";

document.documentElement.style.background = "transparent";
document.body.style.background = "transparent";

const root = document.getElementById("root");
if (root) {
  ReactDOM.createRoot(root).render(
    React.createElement(
      React.StrictMode,
      null,
      React.createElement(DeskpetPet),
    ),
  );
}

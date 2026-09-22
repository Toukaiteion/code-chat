import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles.css'

// 入口模块：改这里会让 Vite 走**整页刷新**（而不是热更新），
// 是「让 IpcSelfCheck 的探针重跑一遍」最省事的手段 —— 不必重启 Electron。

const container = document.getElementById('root')
if (!container) throw new Error('找不到 #root 挂载点')

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>
)

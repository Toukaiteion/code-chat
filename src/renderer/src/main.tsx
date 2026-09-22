import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles.css'

// 入口模块：改这里会让 Vite 走**整页刷新**（而不是热更新），
// 于是 <App> 连同它的 store 一起重建 —— 在 store 里手动改脏了状态、想从头来一遍时，
// 这是最省事的手段（不必重启 Electron）。
//
// `<StrictMode>` 在开发模式下会让 effect 跑两遍。整套 UI 是**照着这条前提**写的：
// 所有 effect 只读、幂等，写入一律由用户动作触发。

const container = document.getElementById('root')
if (!container) throw new Error('找不到 #root 挂载点')

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>
)

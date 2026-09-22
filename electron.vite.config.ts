import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import type { Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const sharedDir = resolve('src/shared')

/**
 * dev 专用：放宽 index.html 里的 script-src。
 *
 * 原因：@vitejs/plugin-react 在 dev 会往 index.html 注入一段 **inline** module script
 * （react-refresh preamble，负责 injectIntoGlobalHook 与 $RefreshReg$/$RefreshSig$）。
 * 严格的 `script-src 'self'` 会把它挡掉，preamble 缺失 → 组件热更新在客户端抛错，
 * 退化成整页刷新，恰好破坏 M0 的验收标准。
 *
 * CSP 仍写在 index.html 的 meta 里而不是走响应头，因为生产环境是 `file://` 加载，
 * onHeadersReceived 对 file:// 不可靠；meta 两种加载方式都生效。
 * 所以这里只在 dev 改写内容，prod 的字符串一个字节都不动。
 */
function devRelaxCsp(): Plugin {
  return {
    name: 'code-chat:dev-relax-csp',
    apply: 'serve',
    transformIndexHtml(html) {
      return html.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'")
    }
  }
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        // node:sqlite 是 Node 24 内置模块（Electron 44 内置 Node 24）。
        // 必须保持 external，否则 Rollup 会尝试解析它并失败。
        external: ['node:sqlite']
      }
    },
    resolve: { alias: { '@shared': sharedDir } }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { '@shared': sharedDir } }
  },
  renderer: {
    plugins: [react(), tailwindcss(), devRelaxCsp()],
    resolve: {
      alias: {
        '@shared': sharedDir,
        '@': resolve('src/renderer/src')
      }
    },
    build: {
      // electron-vite 默认不压缩，产物是 ~653kB 可读源码（14427 行）。
      // 压缩后约 200kB —— 每次开窗都要解析这一坨，值得压。
      // 只作用于 `vite build`，dev server 不经过这里。
      minify: 'esbuild'
    }
  }
})

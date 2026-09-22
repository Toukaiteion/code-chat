import { useStore } from '../store'
import { Button } from './ui/Button'
import { Em } from './ui/Text'

/**
 * 首启空态（§3.5）。全屏居中，因为这时候侧边栏里什么都没有，摆着也是空的。
 *
 * ★ **绝不从这里自动建一个默认空间。** effect 在 StrictMode 下会跑两遍，
 *   一个「发现没有空间就建一个」的 effect 会建出两个来 —— M3 已经被这个坑咬过一次。
 *   没有空间就是要用户明确点一下「新建工作空间」。
 *
 * ★ 这里**不写死空间目录的绝对路径**。写「`…\AppData\Roaming\code-chat\workspaces\`」
 *   看起来很贴心，但那是猜的：`app.getPath('userData')` 会随应用名、打包方式、
 *   以及 `--user-data-dir` 之类的启动参数变。渲染侧此刻也**没有任何通道**能问到它
 *   （`workspace:paths` 需要一个空间 id，而现在一个都还没有）。
 *   所以这里只说清「它在哪一类位置」，真实路径等第一个空间建出来后由主区如实显示。
 */
export function FirstRun({ onCreate }: { onCreate: () => void }): React.JSX.Element {
  const pending = useStore((s) => s.pending['workspace:create'] === true)

  return (
    <div className="bg-void text-ink flex h-screen items-center justify-center px-6">
      <div className="border-edge bg-panel/40 w-full max-w-lg rounded-xl border px-7 py-7 text-center">
        <h1 className="text-ink text-base font-semibold">还没有工作空间</h1>
        <p className="text-ink-dim mt-2 text-[12.5px] leading-relaxed">
          工作空间是这台机器上的一间「工作室」：项目、成员、以及每个成员能看到哪些项目，
          都归属在它下面。
        </p>

        <Button variant="primary" disabled={pending} onClick={onCreate} className="mt-5">
          {pending ? '正在创建…' : '新建工作空间'}
        </Button>

        <div className="border-edge mt-6 border-t pt-5 text-left">
          <p className="text-ink-faint text-[11.5px] leading-relaxed">
            空间目录建在<Em>应用数据目录</Em>下的 <span className="font-mono">workspaces\</span>{' '}
            里 —— 和数据库同一个笼子，不在「文档」里。等你建出第一个空间，
            主区会把它的<Em tone="dim">真实路径</Em>显示出来，并给一个「在资源管理器中打开」。
          </p>
          <p className="text-ink-faint mt-2.5 text-[11.5px] leading-relaxed">
            项目有三种加进来的方式。其中<Em>原地引用</Em>只是登记一行、指向你已有的目录：
            不复制、不移动，删空间删项目都<Em tone="dim">不会动它一个字节</Em>。
            另外两种（复制、git clone）会真的在磁盘上放一份，那份才是可以随空间一起删掉的。
          </p>
        </div>
      </div>
    </div>
  )
}

import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from 'react'
import { api } from '../../ipc'
import { useStore } from '../../store'
import { toNotice } from '../../store/ui'
import { Button } from './Button'

/** 标签 +（可选）提示 + 控件。提示用来放**代价**（「agent 会直接改你的真实目录」）。 */
export function Field({
  label,
  hint,
  children
}: {
  label: string
  hint?: ReactNode
  children: ReactNode
}): React.JSX.Element {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-ink-dim text-[11px] font-medium">{label}</span>
      {children}
      {hint && <span className="text-ink-faint text-[11px] leading-relaxed">{hint}</span>}
    </label>
  )
}

const INPUT_CLASS =
  'w-full rounded-md border border-edge bg-void/60 px-2.5 py-1.5 text-[12.5px] text-ink ' +
  'placeholder:text-ink-faint outline-none focus:border-edge-bright'

export function TextInput({
  className = '',
  ...rest
}: InputHTMLAttributes<HTMLInputElement>): React.JSX.Element {
  return <input className={`${INPUT_CLASS} ${className}`} {...rest} />
}

export function Select({
  className = '',
  children,
  ...rest
}: SelectHTMLAttributes<HTMLSelectElement>): React.JSX.Element {
  return (
    <select className={`${INPUT_CLASS} appearance-none ${className}`} {...rest}>
      {children}
    </select>
  )
}

/**
 * 路径输入框：**可编辑文本框 + 一个「选择…」按钮**。
 *
 * ★ 顺序是刻意的：**文本框才是主入口**，原生对话框只是便利。
 * 两条理由都写在 §8.2：
 * 1. 用户对自己的目录排布有主张，不该被迫在原生对话框里点来点去；
 * 2. 对话框是**渲染侧够不着的**能力（`dialog.showOpenDialog` 只能在主进程调），
 *    把它做成唯一入口等于把「能不能填这个字段」绑死在一条 IPC 通道上。
 *
 * 取消选择返回 `{ path: null }` —— **取消不是错误**，所以这里什么都不做、不报错。
 */
export function PathInput({
  value,
  onChange,
  mode,
  title,
  placeholder
}: {
  value: string
  onChange: (next: string) => void
  mode: 'file' | 'directory'
  title?: string
  placeholder?: string
}): React.JSX.Element {
  const pushNotice = useStore((s) => s.pushNotice)

  async function pick(): Promise<void> {
    try {
      const { path } = await api.dialog.pickPath(
        title ? { mode, title, defaultPath: value || undefined } : { mode }
      )
      if (path !== null) onChange(path)
    } catch (err) {
      pushNotice(toNotice(err, '打开系统选择器'))
    }
  }

  return (
    <div className="flex items-stretch gap-1.5">
      <TextInput
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        spellCheck={false}
        className="font-mono text-[11.5px]"
      />
      <Button onClick={() => void pick()} className="font-normal">
        选择…
      </Button>
    </div>
  )
}

/** 复选框 + 说明。用于「同时删除副本」这类**有代价**的开关。 */
export function Checkbox({
  checked,
  onChange,
  label,
  hint,
  disabled
}: {
  checked: boolean
  onChange: (next: boolean) => void
  label: ReactNode
  hint?: ReactNode
  disabled?: boolean
}): React.JSX.Element {
  return (
    <label
      className={`flex gap-2 ${disabled ? 'opacity-50' : 'cursor-pointer'} items-start text-[12px]`}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="accent-neon-cyan mt-0.5 size-3.5 shrink-0"
      />
      <span className="flex flex-col gap-0.5">
        <span className="text-ink">{label}</span>
        {hint && <span className="text-ink-faint text-[11px] leading-relaxed">{hint}</span>}
      </span>
    </label>
  )
}

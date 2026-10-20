import { Component, type ErrorInfo, type ReactNode } from 'react'
import { createLogger } from '@shared/log'

const log = createLogger('ui')

interface Props {
  /** Shown in the console line, e.g. "Dock panel". */
  label: string
  /** Any change retries the children (callers pass the project, so an undo or
   *  a fix elsewhere redraws them). */
  resetKey: unknown
  fallback: (error: Error, retry: () => void) => ReactNode
  children: ReactNode
}

/** The app's one render-error boundary: the dock panels (`DockPanel`), the
 *  window's sections outside the dock and the root (`App.tsx`, `main.tsx`) all
 *  use it, so a render error stays in the part that threw instead of
 *  unmounting the whole window. */
export class ErrorBoundary extends Component<Props, { error: Error | null }> {
  state = { error: null as Error | null }

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    log.error(`${this.props.label} crashed${info.componentStack ?? ''}`, error)
  }

  componentDidUpdate(prev: Props): void {
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: null })
  }

  render(): ReactNode {
    const { error } = this.state
    if (!error) return this.props.children
    return this.props.fallback(error, () => this.setState({ error: null }))
  }
}

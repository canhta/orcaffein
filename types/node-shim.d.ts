// The few Node APIs the worker uses, so `npx tsc -p .` type-checks without installing
// @types/node (Orca's generated typings do not include Node's).

declare module 'node:child_process' {
  export type ExecFileOptions = {
    signal?: AbortSignal
    timeout?: number
    maxBuffer?: number
    env?: Record<string, string>
  }
  export type ExecFileError = Error & { code?: number | string | null; killed?: boolean }
  export function execFile(
    file: string,
    args: readonly string[],
    options: ExecFileOptions,
    callback: (error: ExecFileError | null, stdout: string, stderr: string) => void
  ): unknown
  export type ChildProcess = {
    pid?: number
    unref(): void
    kill(signal?: string): boolean
    stdout?: NodeReadable | null
    on(event: 'exit' | 'error', listener: () => void): ChildProcess
  }
  export function spawn(
    command: string,
    args: readonly string[],
    options: {
      detached?: boolean
      stdio?: 'ignore' | readonly ('ignore' | 'pipe')[]
      env?: Record<string, string>
    }
  ): ChildProcess
}

type NodeReadable = { readonly readable: boolean }

declare module 'node:readline' {
  export type Interface = {
    on(event: 'line', listener: (line: string) => void): Interface
    close(): void
  }
  export function createInterface(options: { input: NodeReadable }): Interface
}

declare module 'node:os' {
  export function userInfo(): { username: string }
}

declare module 'node:url' {
  export function fileURLToPath(url: string | URL): string
}

declare const process: {
  readonly platform: string
  readonly pid: number
  readonly execPath: string
  readonly env: Record<string, string | undefined>
  kill(pid: number, signal?: string | number): boolean
}

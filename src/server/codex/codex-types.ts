export type CodexProcessOptions = {
  command: string
  args: string[]
  cwd: string
}

export type CodexClientInfo = {
  name: string
  title: string
  version: string
}

export type JsonRpcId = string | number

export type CodexJsonRpcClientEvent =
  | { type: "notification"; method: string; params?: unknown }
  | {
      type: "server_request"
      id: JsonRpcId
      method: string
      params?: unknown
    }
  | {
      type: "exit"
      code: number | null
      signal: NodeJS.Signals | null
      stderr: string
    }
  | { type: "protocol_error"; message: string; raw?: string }

export type CodexJsonRpcClientListener = (event: CodexJsonRpcClientEvent) => void

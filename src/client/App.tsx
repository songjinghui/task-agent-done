import type { ReactNode } from "react"
import { createTaskMuxApi, type TaskMuxApi } from "./api.js"
import {
  ConversationProvider,
  useConversations,
} from "./conversation-store.js"
import { Sidebar } from "./components/Sidebar.js"
import { Thread } from "./components/Thread.js"

const browserApi = createTaskMuxApi()

export function App({ api = browserApi }: { api?: TaskMuxApi }): ReactNode {
  return (
    <ConversationProvider api={api}>
      <Workspace />
    </ConversationProvider>
  )
}

function Workspace(): ReactNode {
  const {
    state,
    conversations,
    selectedConversation,
    selectedDetail,
    createConversation,
    select,
    retrySelectedDetail,
  } = useConversations()

  return (
    <div className="workspace-shell">
      <Sidebar
        workspace={state.workspace}
        conversations={conversations}
        selectedId={state.selectedId}
        loading={state.loading.list}
        creating={state.loading.create}
        onCreate={() => void createConversation()}
        onSelect={select}
      />
      <div className="work-area">
        {state.error ? (
          <div className="page-error" role="alert">
            <span>{state.error}</span>
            {state.errorScope === "detail" ? (
              <button type="button" onClick={retrySelectedDetail}>
                重试
              </button>
            ) : null}
          </div>
        ) : null}
        <Thread
          conversation={selectedConversation}
          detail={selectedDetail}
          loading={state.loading.detail}
          unavailable={state.errorScope === "detail"}
        />
      </div>
    </div>
  )
}

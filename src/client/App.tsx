import type { ReactNode } from "react"
import { createTaskMuxApi, type TaskMuxApi } from "./api.js"
import {
  ConversationProvider,
  isAnyConversationRunning,
  isConversationActive,
  selectApproval,
  selectDisplayedTurns,
  selectLiveText,
  selectTools,
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
    sendMessage,
    cancelSelected,
    respondToApproval,
  } = useConversations()

  const selectedId = state.selectedId
  const live = selectedId ? state.liveByConversationId[selectedId] : undefined
  const active = selectedId
    ? isConversationActive(state, selectedId)
    : false
  const turns = selectedId ? selectDisplayedTurns(state, selectedId) : []
  const tools = selectedId ? selectTools(state, selectedId) : []
  const approval = selectedId ? selectApproval(state, selectedId) : null
  const liveText =
    selectedId && live?.activeTurnId
      ? selectLiveText(state, selectedId, live.activeTurnId)
      : ""

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
        {state.streamStatus === "disconnected" ? (
          <div
            className="stream-status"
            role="status"
            aria-label="事件流状态"
          >
            实时连接已断开，正在重连…
          </div>
        ) : null}
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
          turns={turns}
          liveText={liveText}
          tools={tools}
          approval={approval}
          liveError={live?.error ?? null}
          globallyLocked={isAnyConversationRunning(state)}
          active={active}
          onSend={sendMessage}
          onCancel={cancelSelected}
          onApproval={(decision) =>
            approval
              ? respondToApproval(approval.id, decision)
              : Promise.resolve()
          }
        />
      </div>
    </div>
  )
}

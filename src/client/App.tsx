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
    updateDraft,
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
  const pageErrors = Object.entries(state.errors).filter(
    (entry): entry is [string, string] =>
      entry[0] !== "detail" && Boolean(entry[1])
  )
  const detailError =
    state.errors.detail?.conversationId === selectedId
      ? state.errors.detail.message
      : null

  return (
    <div className="workspace-shell">
      <Sidebar
        workspace={state.workspace}
        conversations={conversations}
        selectedId={state.selectedId}
        loading={state.loading.list}
        creating={state.loading.create}
        createDisabled={state.recovering}
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
        {pageErrors.map(([scope, message]) => (
          <div className="page-error" role="alert" key={scope}>
            <span>{message}</span>
          </div>
        ))}
        {detailError ? (
          <div className="page-error" role="alert">
            <span>{detailError}</span>
            <button
              type="button"
              disabled={state.loading.detail}
              onClick={retrySelectedDetail}
            >
              重试
            </button>
          </div>
        ) : null}
        <Thread
          conversation={selectedConversation}
          detail={selectedDetail}
          loading={state.loading.detail}
          unavailable={Boolean(detailError)}
          turns={turns}
          liveText={liveText}
          tools={tools}
          approval={approval}
          approvalError={live?.approvalError ?? null}
          liveError={live?.error ?? null}
          draft={live?.draft ?? ""}
          sending={Boolean(live?.pendingSend)}
          cancelling={live?.cancelPending ?? false}
          sendError={live?.sendError ?? null}
          cancelError={live?.cancelError ?? null}
          globallyLocked={state.recovering || isAnyConversationRunning(state)}
          active={active}
          onDraftChange={updateDraft}
          onSend={() => sendMessage(live?.draft ?? "")}
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

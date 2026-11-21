"use client"

import { useState, useEffect, useRef, useMemo } from "react"
import { useTranslations } from "next-intl"
import {Mail, Calendar, RefreshCw, Trash2, Share2, ChevronDown, ChevronRight, ArrowDownLeft, ArrowUpRight} from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { useThrottle } from "@/hooks/use-throttle"
import { EMAIL_CONFIG } from "@/config"
import { useToast } from "@/components/ui/use-toast"
import { ShareMessageDialog } from "./share-message-dialog"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from "@/components/ui/alert-dialog";

interface Message {
  id: string
  from_address?: string
  to_address?: string
  subject: string
  received_at?: number
  sent_at?: number
  content?: string
  html?: string
  type?: string
  message_id?: string | null
  references?: string | null
}

interface MessageListProps {
  email: {
    id: string
    address: string
  }
  messageType: 'received' | 'sent' | 'thread'
  onMessageSelect: (messageId: string | null, messageType?: 'received' | 'sent') => void
  selectedMessageId?: string | null
  refreshTrigger?: number
}

interface ThreadGroup {
  key: string
  subject: string
  latest: Message
  members: Message[]
  latestTime: number
}

const messageTime = (m: Message) => m.received_at || m.sent_at || 0
const isSentMessage = (m: Message) => m.type === 'sent'

function normalizeSubject(subject: string): string {
  return (subject || "").replace(/^(\s*(re|fwd|fw|回复|转发|轉發)\s*[:：]\s*)+/i, "").trim()
}

// Grouping key: the first id of the References chain is the thread root and
// is shared by every message in the thread. A thread starter has no
// References, so its own Message-ID is the root. Messages stored before
// threading support have neither and fall back to subject + counterpart.
function threadKeyOf(m: Message): string {
  const refs = m.references?.split(/\s+/).filter(Boolean)
  if (refs && refs.length > 0) return `t:${refs[0]}`
  if (m.message_id) return `t:${m.message_id}`
  const counterpart = isSentMessage(m) ? m.to_address : m.from_address
  return `s:${normalizeSubject(m.subject).toLowerCase()}|${counterpart || ""}`
}

function groupThreads(list: Message[]): ThreadGroup[] {
  const map = new Map<string, Message[]>()
  for (const m of list) {
    const key = threadKeyOf(m)
    const arr = map.get(key)
    if (arr) arr.push(m)
    else map.set(key, [m])
  }
  const groups: ThreadGroup[] = []
  for (const [key, members] of map) {
    const sorted = [...members].sort((a, b) => messageTime(a) - messageTime(b))
    const latest = sorted[sorted.length - 1]
    groups.push({
      key,
      subject: normalizeSubject(latest.subject) || latest.subject,
      latest,
      members: sorted,
      latestTime: messageTime(latest),
    })
  }
  return groups.sort((a, b) => b.latestTime - a.latestTime)
}

interface MessageResponse {
  messages: Message[]
  nextCursor: string | null
  total: number
}

export function MessageList({ email, messageType, onMessageSelect, selectedMessageId, refreshTrigger }: MessageListProps) {
  const t = useTranslations("emails.messages")
  const tList = useTranslations("emails.list")
  const tCommon = useTranslations("common.actions")
  const [messages, setMessages] = useState<Message[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const pollTimeoutRef = useRef<Timer>(null)
  const messagesRef = useRef<Message[]>([]) // 添加 ref 来追踪最新的消息列表
  const [total, setTotal] = useState(0)
  const [messageToDelete, setMessageToDelete] = useState<Message | null>(null)
  const [expandedThreads, setExpandedThreads] = useState<Set<string>>(new Set())
  const { toast } = useToast()

  const threads = useMemo(
    () => (messageType === 'thread' ? groupThreads(messages) : []),
    [messages, messageType]
  )

  const toggleThread = (key: string) => {
    setExpandedThreads(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  // 当 messages 改变时更新 ref
  useEffect(() => {
    messagesRef.current = messages
  }, [messages])

  const fetchMessages = async (cursor?: string) => {
    try {
      const url = new URL(`/api/emails/${email.id}`, window.location.origin)
      if (messageType !== 'received') {
        url.searchParams.set('type', messageType)
      }
      if (cursor) {
        url.searchParams.set('cursor', cursor)
      }
      const response = await fetch(url)
      const data = await response.json() as MessageResponse
      
      if (!cursor) {
        const newMessages = data.messages
        const oldMessages = messagesRef.current

        const lastDuplicateIndex = newMessages.findIndex(
          newMsg => oldMessages.some(oldMsg => oldMsg.id === newMsg.id)
        )

        if (lastDuplicateIndex === -1) {
          setMessages(newMessages)
          setNextCursor(data.nextCursor)
          setTotal(data.total)
          return
        }
        const uniqueNewMessages = newMessages.slice(0, lastDuplicateIndex)
        setMessages([...uniqueNewMessages, ...oldMessages])
        setTotal(data.total)
        return
      }
      setMessages(prev => [...prev, ...data.messages])
      setNextCursor(data.nextCursor)
      setTotal(data.total)
    } catch (error) {
      console.error("Failed to fetch messages:", error)
    } finally {
      setLoading(false)
      setRefreshing(false)
      setLoadingMore(false)
    }
  }

  const startPolling = () => {
    stopPolling()
    pollTimeoutRef.current = setInterval(() => {
      if (!refreshing && !loadingMore) {
        fetchMessages()
      }
    }, EMAIL_CONFIG.POLL_INTERVAL)
  }

  const stopPolling = () => {
    if (pollTimeoutRef.current) {
      clearInterval(pollTimeoutRef.current)
      pollTimeoutRef.current = null
    }
  }

  const handleRefresh = async () => {
    setRefreshing(true)
    await fetchMessages()
  }

  const handleScroll = useThrottle((e: React.UIEvent<HTMLDivElement>) => {
    if (loadingMore) return

    const { scrollHeight, scrollTop, clientHeight } = e.currentTarget
    const threshold = clientHeight * 1.5
    const remainingScroll = scrollHeight - scrollTop

    if (remainingScroll <= threshold && nextCursor) {
      setLoadingMore(true)
      fetchMessages(nextCursor)
    }
  }, 200)

  const handleDelete = async (message: Message) => {
    try {
      const isSent = messageType === 'thread' ? isSentMessage(message) : messageType === 'sent'
      const response = await fetch(`/api/emails/${email.id}/${message.id}${isSent ? '?type=sent' : ''}`, {
        method: "DELETE"
      })

      if (!response.ok) {
        const data = await response.json()
        toast({
          title: tList("error"),
          description: (data as { error: string }).error,
          variant: "destructive"
        })
        return
      }

      setMessages(prev => prev.filter(e => e.id !== message.id))
      setTotal(prev => prev - 1)

      toast({
        title: tList("success"),
        description: tList("deleteSuccess")
      })

      if (selectedMessageId === message.id) {
        onMessageSelect(null)
      }
    } catch {
      toast({
        title: tList("error"),
        description: tList("deleteFailed"),
        variant: "destructive"
      })
    } finally {
      setMessageToDelete(null)
    }
  }

  useEffect(() => {
    if (!email.id) {
      return
    }
    setLoading(true)
    setNextCursor(null)
    setExpandedThreads(new Set())
    fetchMessages()
    startPolling() 

    return () => {
      stopPolling() 
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [email.id])

  useEffect(() => {
    if (refreshTrigger && refreshTrigger > 0) {
      setRefreshing(true)
      fetchMessages()
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshTrigger])

  return (
  <>
    <div className="h-full flex flex-col">
      <div className="p-2 flex justify-between items-center border-b border-primary/20">
        <Button
          variant="ghost"
          size="icon"
          onClick={handleRefresh}
          disabled={refreshing}
          className={cn("h-8 w-8", refreshing && "animate-spin")}
        >
          <RefreshCw className="h-4 w-4" />
        </Button>
        <span className="text-xs text-gray-500">
          {total > 0 ? `${total} ${t("messageCount")}` : t("noMessages")}
        </span>
      </div>

      <div className="flex-1 overflow-auto" onScroll={handleScroll}>
        {loading ? (
          <div className="p-4 text-center text-sm text-gray-500">{t("loading")}</div>
        ) : messages.length > 0 ? (
          messageType === 'thread' ? (
            <div className="divide-y divide-primary/10">
              {threads.map(group => {
                const expanded = expandedThreads.has(group.key) || group.members.some(m => m.id === selectedMessageId)
                const single = group.members.length === 1
                return (
                  <div key={group.key}>
                    <div
                      onClick={() => single
                        ? onMessageSelect(group.latest.id, isSentMessage(group.latest) ? 'sent' : 'received')
                        : toggleThread(group.key)}
                      className={cn(
                        "p-3 hover:bg-primary/5 cursor-pointer",
                        group.members.some(m => m.id === selectedMessageId) && "bg-primary/10"
                      )}
                    >
                      <div className="flex items-start gap-3">
                        <Mail className="w-4 h-4 text-primary/60 mt-1" />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <p className="font-medium text-sm truncate">{group.subject}</p>
                            {!single && (
                              <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded-full bg-primary/15 text-primary">
                                {group.members.length}
                              </span>
                            )}
                          </div>
                          <div className="mt-1 flex items-center gap-2 text-xs text-gray-500">
                            <span className="truncate">
                              {isSentMessage(group.latest) ? group.latest.to_address : group.latest.from_address}
                            </span>
                            <span className="flex items-center gap-1">
                              <Calendar className="w-3 h-3" />
                              {new Date(group.latestTime).toLocaleString()}
                            </span>
                          </div>
                        </div>
                        {!single && (
                          expanded
                            ? <ChevronDown className="h-4 w-4 text-gray-400 mt-1 shrink-0" />
                            : <ChevronRight className="h-4 w-4 text-gray-400 mt-1 shrink-0" />
                        )}
                      </div>
                    </div>
                    {!single && expanded && (
                      <div className="border-t border-primary/5">
                        {group.members.map(member => (
                          <div
                            key={member.id}
                            onClick={() => onMessageSelect(member.id, isSentMessage(member) ? 'sent' : 'received')}
                            className={cn(
                              "pl-10 pr-3 py-2 hover:bg-primary/5 cursor-pointer group flex items-center gap-2",
                              selectedMessageId === member.id && "bg-primary/10"
                            )}
                          >
                            {isSentMessage(member)
                              ? <ArrowUpRight className="w-3.5 h-3.5 text-primary/60 shrink-0" />
                              : <ArrowDownLeft className="w-3.5 h-3.5 text-primary/60 shrink-0" />}
                            <span className="text-xs truncate flex-1">
                              {isSentMessage(member) ? member.to_address : member.from_address}
                            </span>
                            <span className="text-[11px] text-gray-500 shrink-0">
                              {new Date(messageTime(member)).toLocaleString()}
                            </span>
                            <div className="opacity-0 group-hover:opacity-100 flex gap-1" onClick={(e) => e.stopPropagation()}>
                              <ShareMessageDialog
                                emailId={email.id}
                                messageId={member.id}
                                messageSubject={member.subject}
                                trigger={
                                  <Button variant="ghost" size="icon" className="h-8 w-8">
                                    <Share2 className="h-4 w-4" />
                                  </Button>
                                }
                              />
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-8 w-8"
                                onClick={(e) => {
                                  e.stopPropagation()
                                  setMessageToDelete(member)
                                }}
                              >
                                <Trash2 className="h-4 w-4 text-destructive" />
                              </Button>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )
              })}
              {loadingMore && (
                <div className="text-center text-sm text-gray-500 py-2">
                  {t("loadingMore")}
                </div>
              )}
            </div>
          ) : (
          <div className="divide-y divide-primary/10">
            {messages.map(message => (
              <div
                key={message.id}
                onClick={() => onMessageSelect(message.id, messageType)}
                className={cn(
                  "p-3 hover:bg-primary/5 cursor-pointer group",
                  selectedMessageId === message.id && "bg-primary/10"
                )}
              >
                <div className="flex items-start gap-3">
                  <Mail className="w-4 h-4 text-primary/60 mt-1" />
                  <div className="min-w-0 flex-1">
                    <p className="font-medium text-sm truncate">{message.subject}</p>
                    <div className="mt-1 flex items-center gap-2 text-xs text-gray-500">
                      <span className="truncate">
                        {message.from_address || message.to_address || ''}
                      </span>
                      <span className="flex items-center gap-1">
                        <Calendar className="w-3 h-3" />
                        {new Date(message.received_at || message.sent_at || 0).toLocaleString()}
                      </span>
                    </div>
                  </div>
                  <div className="opacity-0 group-hover:opacity-100 flex gap-1" onClick={(e) => e.stopPropagation()}>
                    <ShareMessageDialog
                      emailId={email.id}
                      messageId={message.id}
                      messageSubject={message.subject}
                      trigger={
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8"
                        >
                          <Share2 className="h-4 w-4" />
                        </Button>
                      }
                    />
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      onClick={(e) => {
                        e.stopPropagation()
                        setMessageToDelete(message)
                      }}
                    >
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  </div>
                </div>
              </div>
            ))}
            {loadingMore && (
              <div className="text-center text-sm text-gray-500 py-2">
                {t("loadingMore")}
              </div>
            )}
          </div>
          )
        ) : (
          <div className="p-4 text-center text-sm text-gray-500">
            {t("noMessages")}
          </div>
        )}
      </div>
    </div>
    <AlertDialog open={!!messageToDelete} onOpenChange={() => setMessageToDelete(null)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{tList("deleteConfirm")}</AlertDialogTitle>
          <AlertDialogDescription>
            {tList("deleteDescription", { email: messageToDelete?.subject || "" })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{tCommon("cancel")}</AlertDialogCancel>
          <AlertDialogAction
              className="bg-destructive hover:bg-destructive/90"
              onClick={() => messageToDelete && handleDelete(messageToDelete)}
          >
            {tCommon("delete")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </>
  )
} 
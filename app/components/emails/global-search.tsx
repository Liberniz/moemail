"use client"

import { useState, useEffect, useRef } from "react"
import { useTranslations } from "next-intl"
import { Mail, Calendar, ArrowDownLeft, ArrowUpRight } from "lucide-react"
import { cn } from "@/lib/utils"
import { useThrottle } from "@/hooks/use-throttle"

interface SearchMessage {
  id: string
  email_id: string
  email_address: string
  from_address?: string
  to_address?: string
  subject: string
  content?: string
  type?: string
  received_at?: number
  sent_at?: number
}

interface SearchResponse {
  messages: SearchMessage[]
  nextCursor: string | null
  total: number
}

interface GlobalSearchProps {
  query: string
  onResultSelect: (
    email: { id: string; address: string },
    messageId: string,
    messageType: 'received' | 'sent'
  ) => void
  selectedMessageId?: string | null
}

const messageTime = (m: SearchMessage) => m.received_at || m.sent_at || 0
const isSentMessage = (m: SearchMessage) => m.type === 'sent'

function snippetOf(content?: string): string {
  if (!content) return ""
  return content.replace(/\s+/g, " ").trim()
}

export function GlobalSearch({ query, onResultSelect, selectedMessageId }: GlobalSearchProps) {
  const t = useTranslations("emails.search")
  const tMessages = useTranslations("emails.messages")
  const [results, setResults] = useState<SearchMessage[]>([])
  const [loading, setLoading] = useState(false)
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const [total, setTotal] = useState(0)
  const fetchSeqRef = useRef(0)

  const fetchResults = async (q: string, cursor?: string) => {
    const seq = ++fetchSeqRef.current
    try {
      const url = new URL(`/api/emails/search`, window.location.origin)
      url.searchParams.set('q', q)
      if (cursor) {
        url.searchParams.set('cursor', cursor)
      }
      const response = await fetch(url)
      const data = await response.json() as SearchResponse
      // Drop stale responses when the query changed mid-flight.
      if (seq !== fetchSeqRef.current) return
      if (!response.ok) {
        if (!cursor) {
          setResults([])
          setTotal(0)
          setNextCursor(null)
        }
        return
      }
      setResults(prev => cursor ? [...prev, ...data.messages] : data.messages)
      setNextCursor(data.nextCursor)
      setTotal(data.total)
    } catch (error) {
      console.error("Failed to search messages:", error)
    } finally {
      if (seq === fetchSeqRef.current) {
        setLoading(false)
        setLoadingMore(false)
      }
    }
  }

  useEffect(() => {
    const q = query.trim()
    if (!q) {
      setResults([])
      setTotal(0)
      setNextCursor(null)
      setLoading(false)
      return
    }
    setLoading(true)
    const timer = setTimeout(() => {
      fetchResults(q)
    }, 300)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query])

  const handleScroll = useThrottle((e: React.UIEvent<HTMLDivElement>) => {
    if (loadingMore || loading) return
    const { scrollHeight, scrollTop, clientHeight } = e.currentTarget
    const threshold = clientHeight * 1.5
    const remainingScroll = scrollHeight - scrollTop
    if (remainingScroll <= threshold && nextCursor) {
      setLoadingMore(true)
      fetchResults(query.trim(), nextCursor)
    }
  }, 200)

  return (
    <div className="h-full flex flex-col">
      <div className="p-2 flex justify-between items-center border-b border-primary/20">
        <span className="text-xs font-medium px-1">{t("title")}</span>
        <span className="text-xs text-gray-500">
          {total > 0 ? `${total} ${t("resultCount")}` : ""}
        </span>
      </div>

      <div className="flex-1 overflow-auto" onScroll={handleScroll}>
        {loading ? (
          <div className="p-4 text-center text-sm text-gray-500">{tMessages("loading")}</div>
        ) : results.length > 0 ? (
          <div className="divide-y divide-primary/10">
            {results.map(message => (
              <div
                key={message.id}
                onClick={() => onResultSelect(
                  { id: message.email_id, address: message.email_address },
                  message.id,
                  isSentMessage(message) ? 'sent' : 'received'
                )}
                className={cn(
                  "p-3 hover:bg-primary/5 cursor-pointer",
                  selectedMessageId === message.id && "bg-primary/10"
                )}
              >
                <div className="flex items-start gap-3">
                  <Mail className="w-4 h-4 text-primary/60 mt-1 shrink-0" />
                  <div className="min-w-0 flex-1">
                    <p className="font-medium text-sm truncate">{message.subject}</p>
                    <div className="mt-1 flex items-center gap-2 text-xs text-gray-500">
                      {isSentMessage(message)
                        ? <ArrowUpRight className="w-3 h-3 shrink-0" />
                        : <ArrowDownLeft className="w-3 h-3 shrink-0" />}
                      <span className="truncate">
                        {isSentMessage(message) ? message.to_address : message.from_address}
                      </span>
                      <span className="flex items-center gap-1 shrink-0">
                        <Calendar className="w-3 h-3" />
                        {new Date(messageTime(message)).toLocaleString()}
                      </span>
                    </div>
                    {snippetOf(message.content) && (
                      <p className="mt-1 text-xs text-gray-400 truncate">{snippetOf(message.content)}</p>
                    )}
                    <div className="mt-1">
                      <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-primary/15 text-primary">
                        {message.email_address}
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            ))}
            {loadingMore && (
              <div className="text-center text-sm text-gray-500 py-2">
                {tMessages("loadingMore")}
              </div>
            )}
          </div>
        ) : (
          <div className="p-4 text-center text-sm text-gray-500">
            {t("noResults")}
          </div>
        )}
      </div>
    </div>
  )
}

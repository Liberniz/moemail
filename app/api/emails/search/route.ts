import { NextResponse } from "next/server"
import { createDb } from "@/lib/db"
import { emails, messages } from "@/lib/schema"
import { eq, and, lt, or, sql, ne, isNull, desc } from "drizzle-orm"
import { encodeCursor, decodeCursor } from "@/lib/cursor"
import { getUserId } from "@/lib/apiKey"
import { checkBasicSendPermission } from "@/lib/send-permissions"

export const runtime = "edge"

const PAGE_SIZE = 20

// Global search across every mailbox the current user owns. Matches the
// keyword (case-insensitive, ASCII) against subject, sender, recipient and
// body text. Uses instr() instead of LIKE so user input needs no wildcard
// escaping. Results merge received + sent, newest first, cursor-paginated
// the same way as the thread list.
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const q = (searchParams.get('q') || '').trim()
  const cursorStr = searchParams.get('cursor')

  if (!q) {
    return NextResponse.json(
      { error: "缺少搜索关键词" },
      { status: 400 }
    )
  }
  if (q.length > 100) {
    return NextResponse.json(
      { error: "关键词过长" },
      { status: 400 }
    )
  }

  try {
    const db = createDb()
    const userId = await getUserId()
    if (!userId) {
      return NextResponse.json(
        { error: "未登录" },
        { status: 401 }
      )
    }

    // Mirror the per-mailbox lists: without send permission, sent mail is
    // not visible anywhere, so it is excluded from search results too.
    const { canSend } = await checkBasicSendPermission(userId)

    const match = or(
      sql`instr(lower(${messages.subject}), lower(${q})) > 0`,
      sql`instr(lower(${messages.fromAddress}), lower(${q})) > 0`,
      sql`instr(lower(${messages.toAddress}), lower(${q})) > 0`,
      sql`instr(lower(${messages.content}), lower(${q})) > 0`
    )

    const baseConditions = [
      eq(emails.userId, userId),
      match!
    ]
    if (!canSend) {
      baseConditions.push(or(ne(messages.type, "sent"), isNull(messages.type))!)
    }

    const totalResult = await db.select({ count: sql<number>`count(*)` })
      .from(messages)
      .innerJoin(emails, eq(messages.emailId, emails.id))
      .where(and(...baseConditions))
    const totalCount = Number(totalResult[0].count)

    // Merged received + sent ordering, same coalesce trick as thread mode
    // (timestamps are stored as integer ms in D1).
    const msgTime = sql<number>`coalesce(${messages.receivedAt}, ${messages.sentAt})`

    const conditions = [...baseConditions]
    if (cursorStr) {
      const { timestamp, id } = decodeCursor(cursorStr)
      conditions.push(
        or(
          lt(msgTime, timestamp),
          and(
            eq(msgTime, timestamp),
            lt(messages.id, id)
          )
        )!
      )
    }

    const results = await db.select({
      id: messages.id,
      emailId: messages.emailId,
      emailAddress: emails.address,
      fromAddress: messages.fromAddress,
      toAddress: messages.toAddress,
      subject: messages.subject,
      snippet: sql<string>`substr(${messages.content}, 1, 200)`,
      type: messages.type,
      receivedAt: messages.receivedAt,
      sentAt: messages.sentAt
    })
      .from(messages)
      .innerJoin(emails, eq(messages.emailId, emails.id))
      .where(and(...conditions))
      .orderBy(desc(msgTime), desc(messages.id))
      .limit(PAGE_SIZE + 1)

    const hasMore = results.length > PAGE_SIZE
    const page = hasMore ? results.slice(0, PAGE_SIZE) : results
    const lastOnPage = page[page.length - 1]
    const nextCursor = hasMore && lastOnPage
      ? encodeCursor(
          (lastOnPage.receivedAt ?? lastOnPage.sentAt)!.getTime(),
          lastOnPage.id
        )
      : null

    return NextResponse.json({
      messages: page.map(m => ({
        id: m.id,
        email_id: m.emailId,
        email_address: m.emailAddress,
        from_address: m.fromAddress,
        to_address: m.toAddress,
        subject: m.subject,
        content: m.snippet,
        type: m.type ?? "received",
        received_at: m.receivedAt?.getTime(),
        sent_at: m.sentAt?.getTime()
      })),
      nextCursor,
      total: totalCount
    })
  } catch (error) {
    console.error('Failed to search messages:', error)
    return NextResponse.json(
      { error: "搜索失败" },
      { status: 500 }
    )
  }
}

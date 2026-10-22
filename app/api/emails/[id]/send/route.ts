import { NextResponse } from "next/server"
import { getUserId } from "@/lib/apiKey"
import { createDb } from "@/lib/db"
import { emails, messages } from "@/lib/schema"
import { eq } from "drizzle-orm"
import { getRequestContext } from "@cloudflare/next-on-pages"
import { checkSendPermission } from "@/lib/send-permissions"

export const runtime = "edge"

interface SendEmailRequest {
  to: string
  subject: string
  content: string
  replyTo?: {
    messageId?: string
    references?: string
  }
}

// Threading headers come from the original sender and are stored verbatim in
// our own DB, so strip CR/LF to rule out header injection and cap the length
// per RFC 5322 (998 chars per line).
function sanitizeHeaderValue(value: string): string | null {
  const cleaned = value.replace(/[\r\n]+/g, " ").trim()
  if (!cleaned || cleaned.length > 998) return null
  return cleaned
}

// The compose UI is a plain-text textarea, but the body used to be passed to
// Resend as HTML verbatim, so every newline collapsed into a space when the
// mail was rendered (replies arrived as one run-on paragraph). Convert plain
// text to HTML with <br> line breaks and also send a text/plain part; bodies
// that already look like HTML are sent as-is.
function plainTextToHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\r\n|\r|\n/g, "<br>")
}

async function sendWithResend(
  to: string,
  subject: string,
  content: string,
  fromEmail: string,
  config: { apiKey: string },
  headers?: Record<string, string>
) {
  const looksLikeHtml = /<\/?[a-z][^>]*>/i.test(content)
  const html = looksLikeHtml ? content : plainTextToHtml(content)
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      from: fromEmail,
      to: [to],
      subject: subject,
      html,
      ...(looksLikeHtml ? {} : { text: content }),
      ...(headers && Object.keys(headers).length > 0 ? { headers } : {}),
    }),
  })

  if (!response.ok) {
    const errorData = await response.json() as { message?: string }
    console.error('Resend API error:', errorData)
    throw new Error(errorData.message || "Resend发送失败，请稍后重试")
  }

  return { success: true, html }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const userId = await getUserId()
    if (!userId) {
      return NextResponse.json(
        { error: "未授权" },
        { status: 401 }
      )
    }

    const { id } = await params
    const db = createDb()

    const permissionResult = await checkSendPermission(userId)
    if (!permissionResult.canSend) {
      return NextResponse.json(
        { error: permissionResult.error },
        { status: 403 }
      )
    }
    
    const remainingEmails = permissionResult.remainingEmails

    const { to, subject, content, replyTo } = await request.json() as SendEmailRequest

    if (!to || !subject || !content) {
      return NextResponse.json(
        { error: "收件人、主题和内容都是必填项" },
        { status: 400 }
      )
    }

    const email = await db.query.emails.findFirst({
      where: eq(emails.id, id)
    })

    if (!email) {
      return NextResponse.json(
        { error: "邮箱不存在" },
        { status: 404 }
      )
    }

    if (email.userId !== userId) {
      return NextResponse.json(
        { error: "无权访问此邮箱" },
        { status: 403 }
      )
    }

    const env = getRequestContext().env
    const apiKey = await env.SITE_CONFIG.get("RESEND_API_KEY")

    if (!apiKey) {
      return NextResponse.json(
        { error: "Resend 发件服务未配置，请联系管理员" },
        { status: 500 }
      )
    }

    // Threading headers: In-Reply-To points at the original message, References
    // extends the original chain. Without a stored Message-ID (e.g. mail
    // received before this feature) we send a plain message instead.
    const threadHeaders: Record<string, string> = {}
    if (replyTo?.messageId) {
      const inReplyTo = sanitizeHeaderValue(replyTo.messageId)
      if (inReplyTo) {
        threadHeaders['In-Reply-To'] = inReplyTo
        const references = replyTo.references
          ? sanitizeHeaderValue(`${replyTo.references} ${inReplyTo}`)
          : inReplyTo
        if (references) {
          threadHeaders['References'] = references
        }
      }
    }

    const { html: sentHtml } = await sendWithResend(to, subject, content, email.address, { apiKey }, threadHeaders)

    await db.insert(messages).values({
      emailId: email.id,
      fromAddress: email.address,
      toAddress: to,
      subject,
      content,
      type: "sent",
      html: sentHtml,
      // Persist the thread chain so the conversation view can group this
      // sent reply with the received messages it belongs to. The outgoing
      // Message-ID is assigned by the sending service and unknown here.
      references: threadHeaders['References'] ?? null
    })

    return NextResponse.json({ 
      success: true,
      message: "邮件发送成功",
      remainingEmails
    })
  } catch (error) {
    console.error('Failed to send email:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "发送邮件失败" },
      { status: 500 }
    )
  }
} 
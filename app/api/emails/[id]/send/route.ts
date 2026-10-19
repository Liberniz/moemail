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

async function sendWithResend(
  to: string,
  subject: string,
  content: string,
  fromEmail: string,
  config: { apiKey: string },
  headers?: Record<string, string>
) {
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
      html: content,
      ...(headers && Object.keys(headers).length > 0 ? { headers } : {}),
    }),
  })

  if (!response.ok) {
    const errorData = await response.json() as { message?: string }
    console.error('Resend API error:', errorData)
    throw new Error(errorData.message || "Resend发送失败，请稍后重试")
  }

  return { success: true }
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

    await sendWithResend(to, subject, content, email.address, { apiKey }, threadHeaders)

    await db.insert(messages).values({
      emailId: email.id,
      fromAddress: email.address,
      toAddress: to,
      subject,
      content: '',
      type: "sent",
      html: content
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
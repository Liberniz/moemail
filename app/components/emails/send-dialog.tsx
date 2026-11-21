"use client"

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Send } from "lucide-react"
import { useToast } from "@/components/ui/use-toast"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"

export interface ReplyToInfo {
  messageId?: string | null
  references?: string | null
}

interface SendDialogProps {
  emailId: string
  fromAddress: string
  onSendSuccess?: () => void
  // Prefilled values for replying (absent = blank compose)
  initialTo?: string
  initialSubject?: string
  initialContent?: string
  replyTo?: ReplyToInfo
  // Controlled open state; when omitted the dialog manages itself
  open?: boolean
  onOpenChange?: (open: boolean) => void
  // Hide the built-in compose trigger (caller opens the dialog itself,
  // e.g. the Reply button in the message view)
  hideTrigger?: boolean
}

export function SendDialog({
  emailId,
  fromAddress,
  onSendSuccess,
  initialTo,
  initialSubject,
  initialContent,
  replyTo,
  open: controlledOpen,
  onOpenChange,
  hideTrigger = false,
}: SendDialogProps) {
  const t = useTranslations("emails.send")
  const tList = useTranslations("emails.list")
  const tCommon = useTranslations("common.actions")
  const [internalOpen, setInternalOpen] = useState(false)
  const isControlled = controlledOpen !== undefined
  const open = isControlled ? controlledOpen : internalOpen
  const setOpen = (value: boolean) => {
    if (!isControlled) setInternalOpen(value)
    onOpenChange?.(value)
  }
  const [loading, setLoading] = useState(false)
  const [to, setTo] = useState("")
  const [subject, setSubject] = useState("")
  const [content, setContent] = useState("")
  const { toast } = useToast()

  // When opened for a reply, prefill recipient/subject/quoted body.
  // Compose mode (no initials) keeps the previous behavior.
  useEffect(() => {
    if (open && (initialTo !== undefined || initialSubject !== undefined || initialContent !== undefined)) {
      setTo(initialTo ?? "")
      setSubject(initialSubject ?? "")
      setContent(initialContent ?? "")
    }
  }, [open, initialTo, initialSubject, initialContent])

  const handleSend = async () => {
    if (!to.trim() || !subject.trim() || !content.trim()) {
      toast({
        title: tList("error"),
        description: t("toPlaceholder") + ", " + t("subjectPlaceholder") + ", " + t("contentPlaceholder"),
        variant: "destructive"
      })
      return
    }

    setLoading(true)
    try {
      const response = await fetch(`/api/emails/${emailId}/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
        to,
        subject,
        content,
        ...(replyTo?.messageId
          ? { replyTo: { messageId: replyTo.messageId, references: replyTo.references ?? undefined } }
          : {}),
      })
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

      toast({
        title: tList("success"),
        description: t("success")
      })
      setOpen(false)
      setTo("")
      setSubject("")
      setContent("")
      
      onSendSuccess?.()
    
    } catch {
      toast({
        title: tList("error"),
        description: t("failed"),
        variant: "destructive"
      })
    } finally {
      setLoading(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {!hideTrigger && (
      <TooltipProvider>
        <Tooltip>
          <DialogTrigger asChild>
            <TooltipTrigger asChild>
              <Button 
                variant="ghost" 
                size="sm"
                className="h-8 gap-2 hover:bg-primary/10 hover:text-primary transition-colors"
              >
                <Send className="h-4 w-4" />
                <span className="hidden sm:inline">{t("title")}</span>
              </Button>
            </TooltipTrigger>
          </DialogTrigger>
          <TooltipContent className="sm:hidden">
            <p>{t("title")}</p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
      )}
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{replyTo?.messageId ? t("replyTitle") : t("title")}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-4">
          <div className="text-sm text-muted-foreground">
            {t("from")}: {fromAddress}
          </div>
          <Input
            value={to}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setTo(e.target.value)}
            placeholder={t("toPlaceholder")}
          />
          <Input
            value={subject}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setSubject(e.target.value)}
            placeholder={t("subjectPlaceholder")}
          />
          <Textarea
            value={content}
            onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setContent(e.target.value)}
            placeholder={t("contentPlaceholder")}
            rows={6}
          />
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => setOpen(false)} disabled={loading}>
            {tCommon("cancel")}
          </Button>
          <Button onClick={handleSend} disabled={loading}>
            {loading ? t("sending") : t("send")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
} 
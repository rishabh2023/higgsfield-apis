import { useRef, useState } from 'react'
import { Clapperboard, Loader2, Sparkles } from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Slider } from '@/components/ui/slider'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { ApiError, api, newIdempotencyKey, type Generation, type VideoInput } from '@/lib/api'

const RESOLUTIONS: VideoInput['resolution'][] = ['480p', '720p', '1080p', '4k']
const ASPECTS: VideoInput['aspect_ratio'][] = ['16:9', '4:3', '1:1', '3:4', '9:16', '21:9']
const MAX_PROMPT = 5000

type Props = {
  disabled: boolean
  onCreated: (g: Generation) => void
}

export function GenerateForm({ disabled, onCreated }: Props) {
  const [input, setInput] = useState<VideoInput>({
    prompt: '',
    duration: 5,
    resolution: '720p',
    aspect_ratio: '16:9',
    generate_audio: true,
  })
  const [submitting, setSubmitting] = useState(false)
  // One key per intended submission. It is only rotated after the server has answered,
  // so re-clicking after a dropped connection replays the same key instead of creating
  // a second (billed) generation.
  const idemKey = useRef(newIdempotencyKey())

  const set = <K extends keyof VideoInput>(k: K, v: VideoInput[K]) => setInput((p) => ({ ...p, [k]: v }))
  const promptOk = input.prompt.trim().length > 0 && input.prompt.length <= MAX_PROMPT

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (submitting || !promptOk) return
    setSubmitting(true)
    try {
      const g = await api.create({ ...input, prompt: input.prompt.trim() }, idemKey.current)
      idemKey.current = newIdempotencyKey()
      onCreated(g)
      if (g.status === 'rejected') toast.error(g.error ?? 'Higgsfield rejected the request')
      else if (g.status === 'submission_unknown') toast.warning('Submission outcome unknown — not retried automatically')
      else toast.success('Video queued on Higgsfield')
    } catch (err) {
      // Server answered with a validation/config error: safe to use a fresh key next time.
      if (err instanceof ApiError) idemKey.current = newIdempotencyKey()
      toast.error((err as Error).message)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Card>
      <form onSubmit={submit} className="contents">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Clapperboard className="size-4 text-muted-foreground" /> Text to video
          </CardTitle>
          <CardDescription>Seedance 2.0 · bytedance/seedance-2.0/text-to-video</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-5">
          <div className="grid gap-2">
            <div className="flex items-baseline justify-between">
              <Label htmlFor="prompt">Prompt</Label>
              <span className={`text-xs tabular-nums ${input.prompt.length > MAX_PROMPT ? 'text-destructive' : 'text-muted-foreground'}`}>
                {input.prompt.length}/{MAX_PROMPT}
              </span>
            </div>
            <Textarea
              id="prompt"
              rows={5}
              className="resize-none"
              placeholder="A cinematic tracking shot along a sunlit coastal road"
              value={input.prompt}
              onChange={(e) => set('prompt', e.target.value)}
            />
          </div>

          <div className="grid gap-3">
            <div className="flex items-baseline justify-between">
              <Label>Duration</Label>
              <span className="font-mono text-sm tabular-nums">{input.duration}s</span>
            </div>
            <Slider min={4} max={15} step={1} value={[input.duration]} onValueChange={([v]) => set('duration', v)} />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-2">
              <Label>Resolution</Label>
              <Select value={input.resolution} onValueChange={(v) => set('resolution', v as VideoInput['resolution'])}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {RESOLUTIONS.map((r) => (
                    <SelectItem key={r} value={r}>
                      {r}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label>Aspect ratio</Label>
              <Select value={input.aspect_ratio} onValueChange={(v) => set('aspect_ratio', v as VideoInput['aspect_ratio'])}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ASPECTS.map((a) => (
                    <SelectItem key={a} value={a}>
                      {a}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="flex items-center justify-between rounded-lg border px-3 py-2.5">
            <div className="grid gap-0.5">
              <Label htmlFor="audio">Generate audio</Label>
              <span className="text-xs text-muted-foreground">Soundtrack and ambience with the video</span>
            </div>
            <Switch id="audio" checked={input.generate_audio} onCheckedChange={(v) => set('generate_audio', v)} />
          </div>
        </CardContent>
        <CardFooter className="flex-col items-stretch gap-2">
          <Button type="submit" size="lg" disabled={disabled || submitting || !promptOk}>
            {submitting ? <Loader2 className="animate-spin" /> : <Sparkles />}
            {submitting ? 'Submitting…' : 'Generate video'}
          </Button>
          {disabled && <p className="text-center text-xs text-muted-foreground">Save your API key to start generating.</p>}
        </CardFooter>
      </form>
    </Card>
  )
}

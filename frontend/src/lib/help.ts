// Plain-language explanations shown in tooltips and "How it works" boxes.
// Keep them short and free of jargon: the app is used by non-technical people.
import type { ModeId } from '@/lib/api'

export const MODE_HELP: Record<ModeId, { tagline: string; how: string; bestFor: string; example: string }> = {
  text: {
    tagline: 'Describe it, get a new video',
    how: 'Write what should happen and the AI creates a brand-new video from scratch.',
    bestFor: 'Starting a new idea when you have no images or clips yet.',
    example: '“A red sports car drifting through a neon city at night, drone shot, cinematic”',
  },
  image: {
    tagline: 'Bring a photo to life',
    how: 'The video starts on your image and animates it. Add an optional end image and the video moves from the first picture to the second. The prompt (optional) describes the motion.',
    bestFor: 'Product shots, portraits and artwork you already have.',
    example: '“Slow push-in, hair moving in the wind, soft light”',
  },
  reference: {
    tagline: 'Guide it with examples',
    how: 'Give the AI examples to follow, like a character or product image, a clip whose motion you like, or a sound, then describe the new video that should use them.',
    bestFor: 'Keeping the same character, product or style across several videos.',
    example: '“The woman from image 1 walks down the street from video 1”',
  },
  edit: {
    tagline: 'Change something in a video',
    how: 'Keeps your clip’s timing and camera movement but changes what you describe: weather, colours, objects, clothing or overall style. The result is the same length as the original.',
    bestFor: 'Fixing or restyling a video you like without starting over.',
    example: '“Make it snow and turn the car red”',
  },
  extend: {
    tagline: 'Make a video longer',
    how: 'Continues your clip past its last frame, adding the number of seconds you choose (4–30) in the same framing and look. Describe what happens next. The length badge on the result shows its real duration.',
    bestFor: 'Continuing a story, or turning a short clip into a longer one.',
    example: '“The car drives into a tunnel and its headlights turn on”',
  },
}

export const PARAM_HELP: Record<string, string> = {
  duration: 'How long the video is, in seconds. Longer videos take more time and usually cost more credits.',
  resolution: 'Picture sharpness. 480p is quick for testing, 720p is a good default, and 1080p/4k look best but cost more and take longer.',
  aspect_ratio: 'The shape of the video. 16:9 for YouTube and TV, 9:16 for Reels, TikTok and Shorts, 1:1 for square posts, 21:9 for a cinematic widescreen look.',
  generate_audio: 'Adds sound that matches the scene (ambience, effects, music). Turn it off if you’ll add your own soundtrack.',
  bitrate_mode: 'Video file quality. “High” keeps more detail, “standard” makes smaller files.',
  mode: 'Kling quality level. “std” is faster and cheaper, “pro” looks better, and “4k” gives the highest resolution.',
}

export const PROMPT_HELP =
  'Describe the shot like a film director: who or what is in it, what happens, the camera movement, the lighting and the mood. Use the chips below for ideas, or click Speak to say it out loud.'

export const PROMPT_CHIPS: { group: string; items: string[] }[] = [
  { group: 'Camera', items: ['slow push-in', 'drone aerial shot', 'tracking shot', 'handheld camera', 'orbit around the subject', 'close-up'] },
  { group: 'Look', items: ['cinematic', 'golden hour light', 'neon night', 'soft natural light', 'film grain', 'photorealistic'] },
  { group: 'Motion', items: ['slow motion', 'time-lapse', 'smooth motion'] },
]

export const STATUS_HELP: Record<string, string> = {
  submitting: 'Sending your request to Higgsfield.',
  queued: 'Higgsfield received it and it is waiting its turn. You can still cancel.',
  in_progress: 'Higgsfield is making the video. This usually takes a few minutes.',
  completed: 'Done, and a copy is saved on this computer.',
  failed: 'Higgsfield could not make this video. You were not charged.',
  nsfw: 'Blocked by the content filter. You were not charged.',
  canceled: 'Canceled before it started. You were not charged.',
  rejected: 'Refused before starting (for example not enough credits). Nothing was charged.',
  submission_unknown: 'The connection dropped while sending, so it is not known whether Higgsfield received it. It was not resent automatically, so check your Higgsfield console before trying again.',
  timed_out: 'Stopped waiting after 45 minutes. Click “Check again”.',
  stalled: 'Status checks stopped (for example the API key changed). Fix the key in Settings, then click “Check again”.',
}

/** Higgsfield reports low balance as 403 on submit or as a failed status with this wording. */
export function isCreditError(error: string | null | undefined): boolean {
  return !!error && /credit|balance|insufficient|top up/i.test(error)
}

export const TOP_UP_URL = 'https://console.higgsfield.ai'

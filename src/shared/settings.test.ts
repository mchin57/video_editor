import { describe, expect, it } from 'vitest'
import { mcpAddCommand, withAssistantDefaults } from './settings'

describe('withAssistantDefaults', () => {
  it('turns the assistant on when nothing is stored', () => {
    expect(withAssistantDefaults(undefined)).toEqual({ enabled: true })
    expect(withAssistantDefaults({})).toEqual({ enabled: true })
  })

  it('keeps a stored choice', () => {
    expect(withAssistantDefaults({ enabled: false })).toEqual({ enabled: false })
  })
})

describe('mcpAddCommand', () => {
  it('is the one-time user-scope registration line', () => {
    expect(mcpAddCommand('C:\\code\\video_editor\\out\\main\\mcp.js')).toBe(
      'claude mcp add --scope user reel-editor -- node "C:\\code\\video_editor\\out\\main\\mcp.js"'
    )
  })
})

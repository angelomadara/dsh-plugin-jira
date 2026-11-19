/** A small Markdown → Atlassian Document Format converter for comments. */

const INLINE = /(\*\*[^*\n]+\*\*|__[^_\n]+__|`[^`\n]+`|\[[^\]\n]+\]\([^)\s]+\)|\*[^*\n]+\*|_[^_\n]+_)/g

/** Bold, emphasis, inline code and links inside one line. */
function inlineNodes(text) {
  const nodes = []
  let last = 0
  INLINE.lastIndex = 0
  let match
  while ((match = INLINE.exec(text))) {
    if (match.index > last) nodes.push({ type: 'text', text: text.slice(last, match.index) })
    const token = match[0]
    if (token.startsWith('**') || token.startsWith('__')) {
      nodes.push({ type: 'text', text: token.slice(2, -2), marks: [{ type: 'strong' }] })
    } else if (token.startsWith('`')) {
      nodes.push({ type: 'text', text: token.slice(1, -1), marks: [{ type: 'code' }] })
    } else if (token.startsWith('[')) {
      const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token)
      nodes.push({ type: 'text', text: link[1], marks: [{ type: 'link', attrs: { href: link[2] } }] })
    } else {
      nodes.push({ type: 'text', text: token.slice(1, -1), marks: [{ type: 'em' }] })
    }
    last = INLINE.lastIndex
  }
  if (last < text.length) nodes.push({ type: 'text', text: text.slice(last) })
  return nodes.filter((node) => node.text.length > 0)
}

const LIST_BULLET = /^[-*+]\s+/
const LIST_ORDERED = /^\d+[.)]\s+/
const BLOCK_START = /^(```|#{1,6}\s|[-*+]\s+|\d+[.)]\s+)/

function paragraphNodes(lines) {
  const nodes = []
  lines.forEach((line, index) => {
    if (index > 0) nodes.push({ type: 'hardBreak' })
    nodes.push(...inlineNodes(line.trim()))
  })
  return nodes
}

/**
 * Convert comment Markdown to ADF.
 * Supported: paragraphs, `#` headings, `-`/`1.` lists, fenced code blocks, `**bold**`,
 * `*italic*`/`_italic_`, `` `code` `` and `[text](url)`. Nested lists and nested marks
 * are intentionally not parsed.
 */
export function textToAdf(text) {
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n')
  const content = []
  let index = 0
  while (index < lines.length) {
    const line = lines[index]
    if (!line.trim()) {
      index++
      continue
    }

    const fence = /^```(.*)$/.exec(line)
    if (fence) {
      const language = fence[1].trim()
      const body = []
      index++
      while (index < lines.length && !/^```\s*$/.test(lines[index])) {
        body.push(lines[index])
        index++
      }
      index++
      content.push({
        type: 'codeBlock',
        ...(language ? { attrs: { language } } : {}),
        content: [{ type: 'text', text: body.join('\n') || ' ' }],
      })
      continue
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      content.push({ type: 'heading', attrs: { level: heading[1].length }, content: inlineNodes(heading[2].trim()) })
      index++
      continue
    }

    if (LIST_BULLET.test(line)) {
      const items = []
      while (index < lines.length && LIST_BULLET.test(lines[index])) {
        items.push({
          type: 'listItem',
          content: [{ type: 'paragraph', content: inlineNodes(lines[index].replace(LIST_BULLET, '')) }],
        })
        index++
      }
      content.push({ type: 'bulletList', content: items })
      continue
    }

    if (LIST_ORDERED.test(line)) {
      const items = []
      while (index < lines.length && LIST_ORDERED.test(lines[index])) {
        items.push({
          type: 'listItem',
          content: [{ type: 'paragraph', content: inlineNodes(lines[index].replace(LIST_ORDERED, '')) }],
        })
        index++
      }
      content.push({ type: 'orderedList', content: items })
      continue
    }

    const paragraph = [line]
    index++
    while (index < lines.length && lines[index].trim() && !BLOCK_START.test(lines[index])) {
      paragraph.push(lines[index])
      index++
    }
    content.push({ type: 'paragraph', content: paragraphNodes(paragraph) })
  }
  return { type: 'doc', version: 1, content }
}

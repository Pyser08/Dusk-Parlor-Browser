import { sendChat } from '/home/claude/risu-src/src/ts/process/index.svelte'
import { risuChatParser } from '/home/claude/risu-src/src/ts/parser/parser.svelte'
import { setDatabase } from '/home/claude/risu-src/src/ts/storage/database.svelte'
;(globalThis as any).RisuCore = { sendChat, risuChatParser, setDatabase }

import type { AssistantMessage, ToolCall } from "./llm"

export type AssistantMessageEvent =
  | { type: "start"; partial: AssistantMessage }
  | { type: "text_start"; contentIndex: number; partial: AssistantMessage }
  | { type: "text_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
  | { type: "text_end"; contentIndex: number; content: string; partial: AssistantMessage }
  | { type: "thinking_start"; contentIndex: number; partial: AssistantMessage }
  | { type: "thinking_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
  | { type: "thinking_end"; contentIndex: number; content: string; partial: AssistantMessage }
  | { type: "toolcall_start"; contentIndex: number; partial: AssistantMessage }
  | { type: "toolcall_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
  | { type: "toolcall_end"; contentIndex: number; toolCall: ToolCall; partial: AssistantMessage }
  | { type: "done"; reason: Extract<AssistantMessage["stopReason"], "stop" | "length" | "toolUse">; message: AssistantMessage }
  | { type: "error"; reason: Extract<AssistantMessage["stopReason"], "aborted" | "error">; error: AssistantMessage }

class EventStream<T, R = T> implements AsyncIterable<T> {
  private queue: T[] = []
  private waiting: ((value: IteratorResult<T>) => void)[] = []
  private done = false
  private finalResultPromise: Promise<R>
  private resolveFinalResult!: (result: R) => void
  private rejectFinalResult!: (error: unknown) => void
  private readonly isComplete: (event: T) => boolean
  private readonly extractResult: (event: T) => R

  constructor(isComplete: (event: T) => boolean, extractResult: (event: T) => R) {
    this.isComplete = isComplete
    this.extractResult = extractResult
    this.finalResultPromise = new Promise<R>((resolve, reject) => {
      this.resolveFinalResult = resolve
      this.rejectFinalResult = reject
    })
    void this.finalResultPromise.catch(() => {})
  }

  push(event: T): void {
    if (this.done) return
    if (this.isComplete(event)) {
      this.done = true
      this.resolveFinalResult(this.extractResult(event))
    }
    const waiter = this.waiting.shift()
    if (waiter) waiter({ value: event, done: false })
    else this.queue.push(event)
  }

  end(result?: R): void {
    if (this.done) return
    this.done = true
    if (result !== undefined) this.resolveFinalResult(result)
    while (this.waiting.length) this.waiting.shift()!({ value: undefined as never, done: true })
  }

  fail(error: unknown, event?: T): void {
    if (this.done) return
    this.done = true
    if (event !== undefined) {
      const waiter = this.waiting.shift()
      if (waiter) waiter({ value: event, done: false })
      else this.queue.push(event)
    }
    this.rejectFinalResult(error)
    while (this.waiting.length) this.waiting.shift()!({ value: undefined as never, done: true })
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    while (true) {
      if (this.queue.length) yield this.queue.shift()!
      else if (this.done) return
      else {
        const result = await new Promise<IteratorResult<T>>((resolve) => this.waiting.push(resolve))
        if (result.done) return
        yield result.value
      }
    }
  }

  result(): Promise<R> { return this.finalResultPromise }
}

export class AssistantMessageEventStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
  constructor() {
    super(
      (event) => event.type === "done" || event.type === "error",
      (event) => {
        if (event.type === "done") return event.message
        if (event.type === "error") return event.error
        throw new Error("Model stream has no terminal result")
      },
    )
  }
}

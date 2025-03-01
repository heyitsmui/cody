import { LRUCache } from 'lru-cache'
import * as vscode from 'vscode'

import { DocumentContext } from './get-current-doc-context'
import { LastInlineCompletionCandidate } from './getInlineCompletions'
import { logCompletionEvent } from './logger'
import { CompletionProviderTracer, Provider } from './providers/provider'
import { reuseLastCandidate } from './reuse-last-candidate'
import { processInlineCompletions } from './text-processing/process-inline-completions'
import { ContextSnippet, InlineCompletionItem } from './types'

export interface RequestParams {
    /** The request's document **/
    document: vscode.TextDocument

    /** The request's document context **/
    docContext: DocumentContext

    /** The request's inline completion context. **/
    context: vscode.InlineCompletionContext

    /** The cursor position in the source file where the completion request was triggered. **/
    position: vscode.Position

    /** Wether the completion request is multiline or not. **/
    multiline: boolean
}

export interface RequestManagerResult {
    completions: InlineCompletionItem[]
    cacheHit: 'hit' | 'hit-after-request-started' | null
}

/**
 * This class can handle concurrent requests for code completions. The idea is
 * that requests are not cancelled even when the user continues typing in the
 * document. This allows us to cache the results of expensive completions and
 * return them when the user triggers a completion again.
 *
 * It also retests the request against the completion result of an inflight
 * request that just resolved and uses the last candidate logic to synthesize
 * completions if possible.
 */
export class RequestManager {
    private cache = new RequestCache()
    private readonly inflightRequests: Set<InflightRequest> = new Set()
    private completeSuggestWidgetSelection = false

    constructor(
        { completeSuggestWidgetSelection = false }: { completeSuggestWidgetSelection: boolean } = {
            completeSuggestWidgetSelection: false,
        }
    ) {
        this.completeSuggestWidgetSelection = completeSuggestWidgetSelection
    }

    public async request(
        params: RequestParams,
        providers: Provider[],
        context: ContextSnippet[],
        tracer?: CompletionProviderTracer
    ): Promise<RequestManagerResult> {
        const cachedCompletions = this.cache.get(params)
        if (cachedCompletions) {
            return { completions: cachedCompletions, cacheHit: 'hit' }
        }

        const request = new InflightRequest(params)
        this.inflightRequests.add(request)

        Promise.all(providers.map(c => c.generateCompletions(request.abortController.signal, context, tracer)))
            .then(res => res.flat())
            .then(completions =>
                // Shared post-processing logic
                processInlineCompletions(
                    completions.map(item => ({ insertText: item.content })),
                    params
                )
            )
            .then(processedCompletions => {
                // Cache even if the request was aborted or already fulfilled.
                this.cache.set(params, processedCompletions)

                // A promise will never resolve twice, so we do not need to
                // check if the request was already fulfilled.
                request.resolve({ completions: processedCompletions, cacheHit: null })

                this.testIfResultCanBeUsedForInflightRequests(request, processedCompletions)

                return processedCompletions
            })
            .catch(error => {
                request.reject(error)
            })
            .finally(() => {
                this.inflightRequests.delete(request)
            })

        return request.promise
    }

    /**
     * Test if the result can be used for inflight requests. This only works
     * if a completion is a forward-typed version of a previous completion.
     */
    private testIfResultCanBeUsedForInflightRequests(
        resolvedRequest: InflightRequest,
        items: InlineCompletionItem[]
    ): void {
        const { document, position, docContext, context } = resolvedRequest.params
        const lastCandidate: LastInlineCompletionCandidate = {
            uri: document.uri,
            lastTriggerPosition: position,
            lastTriggerCurrentLinePrefix: docContext.currentLinePrefix,
            lastTriggerNextNonEmptyLine: docContext.nextNonEmptyLine,
            lastTriggerSelectedInfoItem: context?.selectedCompletionInfo?.text,
            result: {
                logId: '',
                items,
            },
        }

        for (const request of this.inflightRequests) {
            if (request === resolvedRequest) {
                continue
            }

            if (request.params.document.uri.toString() !== document.uri.toString()) {
                continue
            }

            const synthesizedCandidate = reuseLastCandidate({
                document: request.params.document,
                position: request.params.position,
                lastCandidate,
                docContext: request.params.docContext,
                context: request.params.context,
                completeSuggestWidgetSelection: this.completeSuggestWidgetSelection,
            })

            if (synthesizedCandidate) {
                const synthesizedItems = synthesizedCandidate.items

                logCompletionEvent('synthesizedFromParallelRequest')
                request.resolve({ completions: synthesizedItems, cacheHit: 'hit-after-request-started' })
                request.abortController.abort()
                this.inflightRequests.delete(request)
            }
        }
    }
}

class InflightRequest {
    public promise: Promise<RequestManagerResult>
    public resolve: (result: RequestManagerResult) => void
    public reject: (error: Error) => void
    public abortController: AbortController

    constructor(public params: RequestParams) {
        // The promise constructor is called synchronously, so this is just to
        // make TS happy
        this.resolve = () => {}
        this.reject = () => {}

        this.promise = new Promise<RequestManagerResult>((res, rej) => {
            this.resolve = res
            this.reject = rej
        })
        // We forward a different abort controller to the network request so we
        // can cancel the network request independently of the user cancelling
        // the completion.
        this.abortController = new AbortController()
    }
}

class RequestCache {
    private cache = new LRUCache<string, InlineCompletionItem[]>({ max: 50 })

    private toCacheKey(key: RequestParams): string {
        return `${key.docContext.prefix}█${key.docContext.nextNonEmptyLine}`
    }

    public get(key: RequestParams): InlineCompletionItem[] | undefined {
        return this.cache.get(this.toCacheKey(key))
    }

    public set(key: RequestParams, entry: InlineCompletionItem[]): void {
        this.cache.set(this.toCacheKey(key), entry)
    }
}

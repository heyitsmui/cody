import * as vscode from 'vscode'

import { contentSanitizer } from '@sourcegraph/cody-shared/src/chat/recipes/helpers'
import { ChatMessage } from '@sourcegraph/cody-shared/src/chat/transcript/messages'

import { FixupCodeAction } from '../code-actions/fixup'
import { FixupTask } from '../non-stop/FixupTask'

import { MessageProvider, MessageProviderOptions } from './MessageProvider'

export class FixupManager implements vscode.Disposable {
    private fixupProviders = new Map<FixupTask, FixupProvider>()
    private messageProviderOptions: MessageProviderOptions
    private disposables: vscode.Disposable[] = []

    constructor(options: MessageProviderOptions) {
        this.messageProviderOptions = options
        this.disposables.push(
            vscode.languages.registerCodeActionsProvider('*', new FixupCodeAction(), {
                providedCodeActionKinds: FixupCodeAction.providedCodeActionKinds,
            })
        )
    }

    public getProviderForTask(task: FixupTask): FixupProvider {
        let provider = this.fixupProviders.get(task)

        if (!provider) {
            provider = new FixupProvider({ task, ...this.messageProviderOptions })
            this.fixupProviders.set(task, provider)
        }

        return provider
    }

    public removeProviderForTask(task: FixupTask): void {
        const provider = this.fixupProviders.get(task)

        if (provider) {
            this.fixupProviders.delete(task)
            provider.dispose()
        }
    }

    public dispose(): void {
        for (const disposable of this.disposables) {
            disposable.dispose()
        }
        this.disposables = []
    }
}

interface FixupProviderOptions extends MessageProviderOptions {
    task: FixupTask
}

export class FixupProvider extends MessageProvider {
    private task: FixupTask

    constructor({ task, ...options }: FixupProviderOptions) {
        super(options)
        this.task = task
    }

    public async startFix(): Promise<void> {
        await this.executeRecipe('fixup', this.task.id)
    }

    public async abortFix(): Promise<void> {
        await this.abortCompletion()
    }

    /**
     * Send transcript to the fixup
     */
    protected handleTranscript(transcript: ChatMessage[], isMessageInProgress: boolean): void {
        const lastMessage = transcript[transcript.length - 1]

        // The users' messages are already added through the comments API.
        if (lastMessage?.speaker !== 'assistant') {
            return
        }

        if (lastMessage.displayText) {
            void this.editor.controllers.fixups?.didReceiveFixupText(
                this.task.id,
                isMessageInProgress ? lastMessage.displayText : contentSanitizer(lastMessage.displayText),
                isMessageInProgress ? 'streaming' : 'complete'
            )
        }
    }

    /**
     * TODO: How should we handle errors for fixups?
     * Should we create a new inline chat with the message?
     */
    protected handleError(errorMsg: string): void {
        void this.editor.controllers.inline?.error(errorMsg)
    }

    protected handleTranscriptErrors(): void {
        // not implemented
    }

    protected handleCodyCommands(): void {
        // not implemented
    }

    protected handleHistory(): void {
        // not implemented
    }

    protected handleSuggestions(): void {
        // not implemented
    }

    protected handleMyPrompts(): void {
        // not implemented
    }
}

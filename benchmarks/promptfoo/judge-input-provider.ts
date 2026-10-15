import type {
  ApiProvider,
  CallApiContextParams,
  ProviderResponse,
} from 'promptfoo';

export default class SavedAnswerProvider implements ApiProvider {
  id() {
    return 'saved-anonymous-answer';
  }

  async callApi(
    _prompt: string,
    context?: CallApiContextParams,
  ): Promise<ProviderResponse> {
    const answer = context?.vars?.candidateOutput;
    if (typeof answer !== 'string')
      return { output: '', error: 'saved_answer_missing' };
    return { output: answer };
  }
}

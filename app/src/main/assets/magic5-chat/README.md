# Magic5 DeepSeek chat homepage

This is the DeepSeek-branded chat surface for the Honor phone preview. The
chat homepage owns the primary experience, keeps local conversations, and
calls the OpenAI-compatible DeepSeek API through the Android bridge. API
credentials are stored in Android app preferences rather than in a remote
page. `Remote` opens the existing DSH Remote workbench from the parent asset
page.

The embedded DSH page keeps its existing Bridge transport and native Android
interface. This surface only provides the DeepSeek entry point and does not
duplicate the Remote protocol or its state management.

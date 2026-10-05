// Shared Markdown/HTML policy. Notebook prose and saved HTML outputs use the
// same route as Markdown; widening this policy requires a core policy change.
export const MARKDOWN_SANITIZE_PROFILE = Object.freeze({
    USE_PROFILES: Object.freeze({ html: true }), ADD_ATTR: Object.freeze(['target', 'rel']),
    FORBID_TAGS: Object.freeze(['style', 'script', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'textarea', 'select']),
    FORBID_ATTR: Object.freeze(['style', 'srcdoc']), ALLOW_UNKNOWN_PROTOCOLS: false
});

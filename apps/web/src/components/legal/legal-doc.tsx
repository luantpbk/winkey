import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface LegalDocProps {
  content: string;
  locale: string;
}

export function LegalDoc({ content, locale }: LegalDocProps) {
  const isEnglish = locale === 'en';

  return (
    <div className="max-w-[72ch] mx-auto py-8 sm:py-12 px-4 sm:px-6">
      {isEnglish && (
        <div
          data-testid="legal-english-notice"
          className="mb-8 rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-200/90 leading-relaxed"
        >
          <strong>Note:</strong> This legal document is currently available in Vietnamese only as
          Winkey operates primarily in Vietnam during the closed beta phase.
        </div>
      )}

      <article
        data-testid="legal-article"
        className="prose prose-invert max-w-none text-gray-700 dark:text-gray-300"
      >
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            h1: ({ ...props }) => (
              <h1
                className="text-2xl sm:text-3xl font-extrabold text-gray-900 dark:text-white mt-2 mb-4 tracking-tight leading-snug"
                {...props}
              />
            ),
            h2: ({ ...props }) => (
              <h2
                className="text-xl sm:text-2xl font-bold text-gray-900 dark:text-white mt-8 mb-3 tracking-tight leading-snug"
                {...props}
              />
            ),
            h3: ({ ...props }) => (
              <h3
                className="text-lg sm:text-xl font-semibold text-gray-900 dark:text-white mt-6 mb-2"
                {...props}
              />
            ),
            p: ({ ...props }) => (
              <p
                className="text-gray-700 dark:text-gray-300 leading-relaxed mb-4 text-sm sm:text-base"
                {...props}
              />
            ),
            ul: ({ ...props }) => (
              <ul
                className="list-disc list-outside pl-5 mb-4 space-y-2 text-gray-700 dark:text-gray-300 text-sm sm:text-base"
                {...props}
              />
            ),
            ol: ({ ...props }) => (
              <ol
                className="list-decimal list-outside pl-5 mb-4 space-y-2 text-gray-700 dark:text-gray-300 text-sm sm:text-base"
                {...props}
              />
            ),
            li: ({ ...props }) => <li className="leading-relaxed" {...props} />,
            a: ({ ...props }) => (
              <a
                className="text-red-500 hover:text-red-400 hover:underline transition"
                {...props}
              />
            ),
            strong: ({ ...props }) => (
              <strong className="font-semibold text-gray-900 dark:text-white" {...props} />
            ),
            em: ({ ...props }) => (
              <em
                className="text-gray-500 dark:text-gray-400 italic text-xs sm:text-sm"
                {...props}
              />
            ),
            hr: ({ ...props }) => (
              <hr
                className="my-8 border-[#272727] dark:border-[#272727] border-gray-200"
                {...props}
              />
            ),
            table: ({ ...props }) => (
              <div className="overflow-x-auto my-6 border border-[#272727] dark:border-[#272727] border-gray-200 rounded-xl">
                <table className="w-full text-left text-sm" {...props} />
              </div>
            ),
            th: ({ ...props }) => (
              <th
                className="border-b border-[#272727] dark:border-[#272727] border-gray-200 bg-[#1e1e1e] dark:bg-[#1e1e1e] bg-gray-100 px-4 py-3 font-semibold text-gray-900 dark:text-gray-100 text-sm whitespace-nowrap"
                {...props}
              />
            ),
            td: ({ ...props }) => (
              <td
                className="border-b border-[#272727]/50 dark:border-[#272727]/50 border-gray-200/50 px-4 py-3 text-gray-700 dark:text-gray-300 text-sm align-top"
                {...props}
              />
            ),
          }}
        >
          {content}
        </ReactMarkdown>
      </article>
    </div>
  );
}

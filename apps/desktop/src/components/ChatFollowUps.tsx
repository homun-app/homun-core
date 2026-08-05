import { useTranslation } from "react-i18next";

interface ChatFollowUpsProps {
  suggestions: string[];
  onSelect: (suggestion: string) => void;
}

export function ChatFollowUps({ suggestions, onSelect }: ChatFollowUpsProps) {
  const { t } = useTranslation();

  if (suggestions.length === 0) return null;

  return (
    <div className="chat-followups" aria-label={t("chat.followUpQuestions")}>
      {suggestions.map((suggestion) => (
        <button
          key={suggestion}
          type="button"
          onClick={() => {
            onSelect(suggestion);
          }}
        >
          {suggestion}
        </button>
      ))}
    </div>
  );
}

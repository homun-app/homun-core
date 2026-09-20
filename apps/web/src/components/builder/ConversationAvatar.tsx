export function ConversationAvatar({
  name,
  human = false,
  large = false,
}: {
  name: string;
  human?: boolean;
  large?: boolean;
}) {
  const color = name === "Marta" ? "peach" : name === "Vera" ? "lilac" : name === "Homun" ? "sage" : "mint";
  return (
    <span
      aria-hidden="true"
      className={`cv-avatar ${human ? "cv-person" : `cv-bot ${color}`} ${large ? "large" : ""}`}
    >
      {human ? (
        name.slice(0, 1)
      ) : (
        <span className="cv-eyes">
          <i />
          <i />
        </span>
      )}
    </span>
  );
}

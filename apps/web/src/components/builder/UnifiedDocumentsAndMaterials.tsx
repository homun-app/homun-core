import type { ReactNode } from "react";

type Props = {
  activeTab?: "documents" | "materials";
  documentsView: ReactNode;
  materialsView: ReactNode;
};

export function UnifiedDocumentsAndMaterials({
  activeTab = "documents",
  documentsView,
  materialsView,
}: Props) {
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", width: "100%", overflowY: "auto" }}>
      {activeTab === "documents" ? documentsView : materialsView}
    </div>
  );
}

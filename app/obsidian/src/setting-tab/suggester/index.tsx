import { defaultSettingsSuggester } from "@/note-feature/citation-suggest/settings";
import BooleanSetting from "../components/Boolean";

export default function Suggester() {
  return (
    <>
      <BooleanSetting
        name="Citation editor suggester"
        get={(s) =>
          s.citationEditorSuggester ??
          defaultSettingsSuggester.citationEditorSuggester}
        set={(v, s) => ({ ...s, citationEditorSuggester: v })}
      />
      <BooleanSetting
        name="Show BibTex citekey in suggester"
        get={(s) =>
          s.showCitekeyInSuggester ??
          defaultSettingsSuggester.showCitekeyInSuggester}
        set={(v, s) => ({ ...s, showCitekeyInSuggester: v })}
      />
    </>
  );
}

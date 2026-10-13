import { includeIgnoreFile } from "@eslint/compat";
import { fileURLToPath } from "node:url";
import js from "@eslint/js";
import eslintConfigPrettier from "eslint-config-prettier";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

// Un'unica fonte di verità: ciò che git ignora è ignorato anche dal lint.
const gitIgnored = includeIgnoreFile(fileURLToPath(new URL("./.gitignore", import.meta.url)));

export default tseslint.config(
  gitIgnored,
  {
    ignores: [
      "**/dist/**",
      "dist-prototype/**",
      "**/.output/**",
      "**/.vinxi/**",
      "**/.venv/**",
      "**/.package/**",
      "**/dist-installers/**",
      "coverage/**",
      "output/**",
      "**/.tanstack/**",
      "**/.nitro/**",
    ],
  },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "server-only",
              message:
                "TanStack Start does not use the Next.js `server-only` package. Rename the module to `*.server.ts` or mark it with `@tanstack/react-start/server-only`.",
            },
          ],
        },
      ],
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
      "@typescript-eslint/no-unused-vars": "off",
    },
  },
  // La formattazione è di Prettier (npm run format / format:check): qui resta
  // solo la disattivazione delle regole ESLint in conflitto con Prettier.
  eslintConfigPrettier,
);

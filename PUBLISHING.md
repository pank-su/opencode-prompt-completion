# Первая публикация на GitHub

Целевой репозиторий: `pank-su/opencode-prompt-completion`. Следующие команды
создают **публичный** репозиторий и отправляют в него исходники. Они не
выполняются установщиком или проверками проекта.

1. Поместите эту папку отдельно от других репозиториев. Не переносите историю
   родительского репозитория, личные конфиги, резервные копии или `node_modules`.
2. Выполните `bun install --frozen-lockfile --ignore-scripts` и `bun run check`.
3. Убедитесь, что MIT и указанный автор соответствуют вашим правам на код.
4. Проверьте активный GitHub-аккаунт: `gh api user --jq .login` должен показать
   `pank-su`. Для этих команд нужен установленный GitHub CLI с авторизацией.

Из корня отдельной подготовленной папки:

```sh
git init -b main
git add .github .gitattributes .gitignore package.json bun.lock tsconfig.json LICENSE README.md CHANGELOG.md CONTRIBUTING.md SECURITY.md THIRD_PARTY.md PUBLISHING.md tui.tsx ghost.ts controller.mjs context.mjs editor.mjs prediction.mjs word.mjs scripts tests
git diff --cached --stat
git diff --cached
```

После проверки состава и содержимого:

```sh
git commit -m "Prepare prompt completion 0.2.3"
gh repo create pank-su/opencode-prompt-completion --public --source . --remote origin --push
```

Если репозиторий уже существует, не повторяйте команду создания и не
переписывайте его историю. Сначала проверьте его содержимое и remote.
После отправки проверьте GitHub Actions на всех трёх платформах. До первого
успешного запуска CI не считайте их поддержку проверенной.

`private: true` в `package.json` запрещает случайный `npm publish`, но не
публикацию исходников на GitHub. Публикация в npm этим проектом не настроена.

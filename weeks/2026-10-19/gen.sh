# Генерация картинок: bash week/gen.sh <код> ... (из рабочей папки, VK_DIR и S заданы)
# Если Gemini ответил текстом (NO_IMAGE) — повтор с «нарисуй в формате 1 к 1 : [промпт]»
for c in "$@"; do
  [ -f "week/raw/$c.png" ] && continue
  r=$(node $S/dom.js gemini "week/prompts/$c.txt" "week/raw/$c.png" 2>&1 | tail -1)
  echo "$c | $r"
  echo "$r" | grep -qiE "лимит|limit|NOT_LOGGED_IN" && { echo STOP; exit 1; }
  if echo "$r" | grep -q NO_IMAGE; then
    sleep 25
    mkdir -p week/prompts_1x1
    sed '1s/^нарисуй: /нарисуй в формате 1 к 1 : /' "week/prompts/$c.txt" > "week/prompts_1x1/$c.txt"
    r=$(node $S/dom.js gemini "week/prompts_1x1/$c.txt" "week/raw/$c.png" 2>&1 | tail -1)
    echo "$c (1 к 1) | $r"
    echo "$r" | grep -qiE "лимит|limit|NOT_LOGGED_IN" && { echo STOP; exit 1; }
  fi
  sleep 30
done
echo DONE

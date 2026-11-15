# SPHEREx Explorer — kit de arranque

## 1. Repo (Windows, PowerShell)

```powershell
cd $HOME\Documents\spherex-explorer
git init
git add .
git commit -m "chore: initial project docs"
```

Si van a trabajar los dos, crear el repo en GitHub y hacer push ahora.

## 2. Claude Code: Etapa 0

```powershell
claude
```

Dentro de Claude Code, pegar el contenido de `prompts/etapa-0.md`.
Resultado esperado: `spike/RESULTADOS.md` y `SPEC.md` actualizado.

## 3. Claude Design (en paralelo)

1. Elegir un DESIGN.md oscuro en https://github.com/VoltAgent/awesome-claude-design (candidato: SpaceX).
2. En Claude Design, crear un prototipo nuevo, adjuntar ese DESIGN.md y pegar el texto de `DESIGN_BRIEF.md`.
3. Elegir variantes y exportar el resultado como `DESIGN.md` en la raíz del repo.

## 4. Skill de diseño para Claude Code (antes de la Etapa 1)

Impeccable: https://github.com/pbakaus/impeccable — instalar según su README. Revisar el repo antes de instalar.

## 5. Etapa 1 en adelante

Con `spike/RESULTADOS.md` y `DESIGN.md` listos, pedir a Claude Code: "Leé CLAUDE.md, SPEC.md, DESIGN.md y spike/RESULTADOS.md. Planificá la Etapa 1 de SPEC.md en tareas y esperá mi aprobación antes de escribir código."

# Cómo trabajar con las dos ramas

Este repositorio tiene dos ramas con propósitos distintos. La carpeta que cargas en Chrome
es siempre la misma (`social-reborn-toolkit/`), así que **cambiar de rama cambia el código
que se ejecuta**: después de cada `git checkout` hay que recargar la extensión en
`chrome://extensions` y recargar la pestaña del juego.

## Ramas

| Rama | Contenido | Estado |
| --- | --- | --- |
| `main` | Recolector de carne (meat) y de madera (wood). | Estable. Es la que se usa a diario. |
| `pruebas` | Todo lo de `main` más el recolector de recursos (resources). | El recolector de recursos sigue en prueba. |

La ventana de la extensión (popup) muestra la rama al lado de la versión:
`v2.14.0 (main)` o `v2.15.0 (pruebas)`. Así sabes de un vistazo qué versión está cargada.

## Reglas

1. Todo cambio del recolector de recursos va **solo** a `pruebas`.
2. Un arreglo de meat o wood va a `main` y después se pasa a `pruebas` para que las dos
   ramas no se separen:

   ```
   git checkout main
   git add -A && git commit -m "fix(wood): ..."
   git push origin main
   git checkout pruebas
   git merge main
   git push origin pruebas
   ```

   Ese `git merge main` trae el arreglo y no borra `resources.js`, porque `pruebas` es la
   rama que lo tiene.

3. **Nunca** ejecutes `git merge pruebas` en `main` mientras resources esté en prueba: ese
   merge volvería a meter el módulo de recursos en `main`. Para pasar un arreglo puntual,
   usa `git cherry-pick <commit>`.
4. Cuando resources esté validado, se copia a `main` con `git cherry-pick` de los commits
   del módulo, o se acepta el merge y se deja de considerar en prueba.

## Verificación antes de cada push

```
npm test
```

Ejecuta todos los tests de la rama en la que estás y falla si alguno falla. `main` tiene
menos archivos de test que `pruebas` porque no incluye los de resources.

## Instalación

1. Abre `chrome://extensions` y activa el **modo desarrollador**.
2. Elige **Cargar descomprimida** y selecciona la carpeta `social-reborn-toolkit/`.
3. Abre el juego y recarga la página.
4. Haz clic una vez en el ícono de la extensión en esa pestaña:
   `chrome.tabs.captureVisibleTab` necesita el permiso `activeTab`, que se otorga con esa
   invocación y se pierde al recargar o navegar.

## Si una calibración da 0

El botón 💾 del HUD (o `exportFrame`) descarga la imagen sin pérdida y un JSON con la
configuración y las detecciones. Con esos dos archivos se puede reproducir el caso sin
tener la pantalla del juego delante.

/*
 * Copyright (c) 2016-2025 Martin Donath <martin.donath@squidfunk.com>
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to
 * deal in the Software without restriction, including without limitation the
 * rights to use, copy, modify, merge, publish, distribute, sublicense, and/or
 * sell copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NON-INFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
 * FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS
 * IN THE SOFTWARE.
 */

import {
  EMPTY,
  Observable,
  combineLatest,
  distinctUntilChanged,
  filter,
  fromEvent,
  map,
  of,
  shareReplay,
  startWith,
  switchMap,
  zip
} from "rxjs"

import { feature } from "~/_"
import {
  Viewport,
  getElements,
  getOptionalElement,
  requestHTML,
  watchElementFocus,
  watchElementHover
} from "~/browser"
import { Sitemap } from "~/integrations"
import { renderTooltip2 } from "~/templates"

import { Component } from "../../_"
import { mountTooltip2 } from "../../tooltip2"

/* ----------------------------------------------------------------------------
 * Types
 * ------------------------------------------------------------------------- */

/**
 * Link
 */
export interface Link {}

/* ----------------------------------------------------------------------------
 * Helper types
 * ------------------------------------------------------------------------- */

/**
 * Dependencies
 */
interface Dependencies {
  sitemap$: Observable<Sitemap>        // Sitemap observable
  viewport$: Observable<Viewport>      // Viewport observable
  target$: Observable<HTMLElement>     // Location target observable
  print$: Observable<boolean>          // Media print observable
}

/* ----------------------------------------------------------------------------
 * Data
 * ------------------------------------------------------------------------- */

/**
 * Global sequence number for instant previews
 */
let sequence = 0

/* ----------------------------------------------------------------------------
 * Helper functions
 * ------------------------------------------------------------------------- */

/**
 * Extract elements until next heading
 *
 * @param headline - Heading
 *
 * @returns Elements until next heading
 */
function extract(headline: HTMLElement): HTMLElement[] {
  const newHeading = document.createElement("h3")
  newHeading.innerHTML = headline.innerHTML

  const els = [ newHeading as HTMLElement, ...nextElements(headline) ]

  // If the headline is actually a bare <a>, collect the elements following its parent too
  if (headline instanceof HTMLAnchorElement && headline.textContent === "") {
    els.push(...nextElements(headline.parentElement!))
  }

  // Customization for mkdocstrings usage in Minsc - if the heading is inside mkdocstring's .doc,
  // also include any .doc-contents or .doc-signature that follow the .doc parent
  else if (headline.parentElement?.classList.contains("doc")) {
    els.push(...nextElements(headline.parentElement, el =>
      el.classList.contains("doc-contents") || el.classList.contains("doc-signature")))
  }

  //
  return els
}

function nextElements(
  baseElement: HTMLElement,
  predicate: (el: Element) => boolean = (el: Element) => !(el instanceof HTMLHeadingElement || el.classList.contains("doc"))
): HTMLElement[] {
  const els = []
  let nextElement = baseElement.nextElementSibling
  while (nextElement && predicate(nextElement)) {
    els.push(nextElement as HTMLElement)
    nextElement = nextElement.nextElementSibling
  }
  return els
}

/**
 * Resolve relative URLs in the given document
 *
 * @todo deduplicate with resolution in instant navigation. This functoion also
 * adds the ability to resolve from a specific base URL, which is essential for
 * instant previews to work, so we should generalize this functionality the
 * next time we work on instant navigation.
 *
 * @param document - Document
 * @param base - Base URL
 *
 * @returns Document observable
 */
function resolve(
  document: Document, base: URL | string
): Observable<Document> {

  // Replace all links
  for (const el of getElements("[href], [src]", document))
    for (const key of ["href", "src"]) {
      const value = el.getAttribute(key)
      if (value && !/^(?:[a-z]+:)?\/\//i.test(value)) {
        // @ts-expect-error - trick: self-assign to resolve URL
        el[key] = new URL(el.getAttribute(key), base).toString()
        break
      }
    }

  // Ensure ids are free of collisions (e.g. content tabs)
  for (const el of getElements("[name^=__], [for]", document))
    for (const key of ["id", "for", "name"]) {
      const value = el.getAttribute(key)
      if (value) {
        el.setAttribute(key, `${value}$preview_${sequence}`)
      }
    }

  // Return document observable
  sequence++
  return of(document)
}

/**
 * Instant preview toggle state
 */
const instantPreviewForm = getOptionalElement("[data-md-component=instant-preview-toggle]")

const instantPreviewEnabled$ = !instantPreviewForm ? of(true) :
    fromEvent(instantPreviewForm, "change").pipe(
      map(e => (e.target as HTMLInputElement).value === "on"),
      startWith(__md_get("instant.preview") ?? true),
      distinctUntilChanged(),
      shareReplay(1)
    )

instantPreviewEnabled$.subscribe(enabled => {
  __md_set("instant.preview", enabled)
  const onoff =  enabled ? "on" : "off"
  document.body.dataset.instantPreview = onoff
  const input = getOptionalElement(`input[name=__instant_preview][value=${onoff}]`)
  if (input) (input as HTMLInputElement).checked = true
})

/* ----------------------------------------------------------------------------
 * Functions
 * ------------------------------------------------------------------------- */

/**
 * Mount Link
 *
 * @param el - Link element
 * @param dependencies - Depenendencies
 *
 * @returns Link component observable
 */
export function mountLink(
  el: HTMLElement, dependencies: Dependencies
): Observable<Component<Link>> {
  const { sitemap$ } = dependencies
  if (!(el instanceof HTMLAnchorElement))
    return EMPTY

  // Only enabled on browsers that support 'hover' state (i.e. non-mobile)
  if (!window.matchMedia("(hover: hover)").matches)
    return EMPTY

  //
  if (!(
    feature("navigation.instant.preview") ||
    el.hasAttribute("data-preview")
  )) return EMPTY

  // Don't override links with explicit `title`
  if (el.title)
    return EMPTY

  // Early return for external links or non-links, so the title attribute isn't removed
  if (!el.href || new URL(el.href).host !== location.host)
    return EMPTY

  const active$ =
    combineLatest([
      watchElementFocus(el),
      watchElementHover(el),
      instantPreviewEnabled$
    ])
      .pipe(
        map(([focus, hover, enabled]) => (focus || hover) && enabled),
        distinctUntilChanged(),
        filter(active => active)
      )

  // @todo: this is taken from the handle function in instant loading - we
  // should generalize this once instant loading becomes stable.
  const elements$ = zip([sitemap$, active$]).pipe(
    switchMap(([sitemap]) => {
      const url = new URL(el.href)
      url.search = url.hash = ""

      //
      if (!sitemap.has(`${url}`))
        return EMPTY

      //
      return of(url)
    }),
    switchMap(url => requestHTML(url).pipe(
      switchMap(doc => resolve(doc, url))
    )),
    switchMap(doc => {
      const selector = el.hash
        ? `article [id="${decodeURIComponent(el.hash.slice(1))}"]`
        : "article h1"

      //
      const target = getOptionalElement(selector, doc)
      if (typeof target === "undefined")
        return EMPTY

      const els = extract(target)
      // If all we have to show is the title element, don't show the tooltip at all
      if (els.length == 1) return EMPTY

      return of(els)
    })
  )

  //
  return elements$.pipe(
    switchMap(els => {
      const content$ = new Observable<HTMLElement>(observer => {
        const node = renderTooltip2(...els)
        observer.next(node)

        //
        document.body.append(node)
        return () => node.remove()
      })

      //
      return mountTooltip2(el, { content$, enabled$: instantPreviewEnabled$, ...dependencies })
    })
  )
}

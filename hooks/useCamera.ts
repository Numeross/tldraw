/* eslint-disable @typescript-eslint/explicit-module-boundary-types */
import React, { useEffect } from 'react'
import state from 'state'
import storage from 'state/storage'
import { getCurrentCamera } from 'utils'

/**
 * When the state's camera changes, update the transform of
 * the SVG group to reflect the correct zoom and pan.
 * @param ref
 */
export default function useCamera(ref: React.MutableRefObject<SVGGElement>) {
  useEffect(() => {
    let prev = getCurrentCamera(state.data)

    return state.onUpdate(() => {
      const g = ref.current
      if (!g) return

      const { point, zoom } = getCurrentCamera(state.data)

      if (point !== prev.point || zoom !== prev.zoom) {
        g.setAttribute(
          'transform',
          `scale(${zoom}) translate(${point[0]} ${point[1]})`
        )

        storage.savePageState(state.data)

        prev = getCurrentCamera(state.data)
      }
    })
  }, [state])
}

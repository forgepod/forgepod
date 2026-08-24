"""Beam statics over MCP: the first ForgePod plugin, kept deliberately small.

It exists to prove one thing, that a plugin carrying binary scientific
dependencies (numpy, scipy) is discoverable and callable by the TypeScript core
with no Python anywhere in that core. Real structural work belongs in a plugin
built on PyNite or IndeterminateBeam; those sit on top of these same two wheels,
so the dependency risk this proves is the same one they carry.
"""

from typing import TypedDict

import numpy as np
from mcp.server.mcpserver import MCPServer
from scipy.linalg import solve

mcp = MCPServer(
    name="beam-mcp",
    version="0.1.0",
    instructions="Statics for a simply supported beam. Lengths in metres, forces in kN.",
)


class Reactions(TypedDict):
    reaction_left_kn: float
    reaction_right_kn: float
    max_moment_knm: float


class SectionProperties(TypedDict):
    inertia_mm4: float
    section_modulus_mm3: float


# The return types are declared so MCP publishes an output schema and the core
# receives validated structured data instead of a JSON string to re-parse.
@mcp.tool()
def beam_reactions(span_m: float, load_kn: float, load_from_left_m: float) -> Reactions:
    """Support reactions and peak bending moment for a simply supported beam carrying one point load."""
    if span_m <= 0:
        raise ValueError("span_m must be positive")
    if not 0 <= load_from_left_m <= span_m:
        raise ValueError("load_from_left_m must sit within the span")

    # Vertical equilibrium and moments about the left support, solved as a system
    # rather than rearranged by hand, so adding redundant supports later is a
    # bigger matrix instead of new algebra.
    coeff = np.array([[1.0, 1.0], [0.0, span_m]])
    rhs = np.array([load_kn, load_kn * load_from_left_m])
    reaction_left, reaction_right = solve(coeff, rhs)

    return {
        "reaction_left_kn": round(float(reaction_left), 6),
        "reaction_right_kn": round(float(reaction_right), 6),
        "max_moment_knm": round(float(reaction_left * load_from_left_m), 6),
    }


@mcp.tool()
def rectangular_section_modulus(width_mm: float, height_mm: float) -> SectionProperties:
    """Second moment of area and elastic section modulus for a solid rectangle."""
    if width_mm <= 0 or height_mm <= 0:
        raise ValueError("width_mm and height_mm must be positive")
    inertia = width_mm * height_mm**3 / 12
    return {
        "inertia_mm4": round(inertia, 3),
        "section_modulus_mm3": round(inertia / (height_mm / 2), 3),
    }


if __name__ == "__main__":
    mcp.run(transport="stdio")

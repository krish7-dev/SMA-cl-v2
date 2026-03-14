package com.sma.strategyengine.strategy;

/**
 * Tracks the current directional position of a strategy instance.
 *
 * <ul>
 *   <li>FLAT  — no open position</li>
 *   <li>LONG  — net long position (bought and holding)</li>
 *   <li>SHORT — net short position (sold short, awaiting cover)</li>
 * </ul>
 *
 * Direction is maintained in-memory in {@link com.sma.strategyengine.service.EvaluationService}
 * and reset when an instance is deactivated or deleted.
 */
public enum PositionDirection {
    FLAT,
    LONG,
    SHORT
}

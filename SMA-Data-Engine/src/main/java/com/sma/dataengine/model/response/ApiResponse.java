package com.sma.dataengine.model.response;

import lombok.Getter;

import java.time.Instant;

/**
 * Uniform envelope for all Data Engine API responses.
 */
@Getter
public class ApiResponse<T> {

    private final boolean success;
    private final String  message;
    private final T       data;
    private final String  timestamp;

    private ApiResponse(boolean success, String message, T data) {
        this.success   = success;
        this.message   = message;
        this.data      = data;
        this.timestamp = Instant.now().toString();
    }

    public static <T> ApiResponse<T> ok(T data) {
        return new ApiResponse<>(true, "OK", data);
    }

    public static <T> ApiResponse<T> ok(T data, String message) {
        return new ApiResponse<>(true, message, data);
    }

    public static <T> ApiResponse<T> error(String message) {
        return new ApiResponse<>(false, message, null);
    }
}

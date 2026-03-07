package com.sma.brokerengine.entity;

import jakarta.persistence.*;
import lombok.*;
import org.hibernate.annotations.CreationTimestamp;
import org.hibernate.annotations.UpdateTimestamp;

import java.time.Instant;

/**
 * Represents a registered broker account within the platform.
 * Sensitive tokens and API secrets are stored encrypted.
 */
@Entity
@Table(name = "broker_account", uniqueConstraints = {
        @UniqueConstraint(name = "uq_broker_account_user_broker", columnNames = {"user_id", "broker_name"})
})
@Getter
@Setter
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class BrokerAccount {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(name = "user_id", nullable = false)
    private String userId;

    @Column(name = "broker_name", nullable = false, length = 50)
    private String brokerName;

    @Column(name = "client_id", nullable = false, length = 100)
    private String clientId;

    /**
     * Encrypted API key — never stored in plain text.
     */
    @Column(name = "api_key_encrypted", nullable = false, columnDefinition = "TEXT")
    private String apiKeyEncrypted;

    /**
     * Encrypted API secret — never stored in plain text.
     */
    @Column(name = "api_secret_encrypted", nullable = false, columnDefinition = "TEXT")
    private String apiSecretEncrypted;

    /**
     * Encrypted access token issued after login. Refreshed on each session.
     */
    @Column(name = "access_token_encrypted", columnDefinition = "TEXT")
    private String accessTokenEncrypted;

    @Column(name = "token_expiry")
    private Instant tokenExpiry;

    @Enumerated(EnumType.STRING)
    @Column(name = "status", nullable = false, length = 20)
    private AccountStatus status;

    @CreationTimestamp
    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    @UpdateTimestamp
    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt;

    public enum AccountStatus {
        ACTIVE, INACTIVE, TOKEN_EXPIRED, SUSPENDED
    }
}

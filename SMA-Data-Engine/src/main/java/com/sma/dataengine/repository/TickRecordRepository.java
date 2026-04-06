package com.sma.dataengine.repository;

import com.sma.dataengine.model.TickRecord;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;

@Repository
public interface TickRecordRepository extends JpaRepository<TickRecord, Long> {
}
